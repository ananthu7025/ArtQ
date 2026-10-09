// COD remittances (task 5.6; architecture.md §10.5, api.md §4.7, database.md §8.4a) [cod:remit]. A courier pays out the
// cash it collected for a batch of delivered COD orders; staff record the payout with the courier's reference.
// aq_record_cod_remittance checks the lines add up, takes each order once (even under concurrency), marks it
// COD_REMITTED and raises COD_REMITTANCE_MISMATCH for an order paid a different amount than its total.
//   GET  /admin/cod/outstanding?courier=&overdue=1     delivered COD orders not yet remitted, oldest first, + summary
//   GET  /admin/cod-remittances                         recorded payouts, newest first, with their orders
//   POST /admin/cod-remittances                         record one payout → {remittance, mismatches}
// The daily `cod-overdue` job emails staff when cash has been outstanding longer than COD_OVERDUE_DAYS.
import { COD_OVERDUE_DAYS, codOutstandingQuery, codRemittanceBody, codRemittanceListQuery, type CodOutstandingRow, type CodOutstandingSummary, type CodRemittanceResult, type CodRemittanceRow, type Permission } from '@artq/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Request, RequestHandler, Response, Router } from 'express';
import type { z } from 'zod';
import { recordAudit } from '../admin/router.js';
import { DbFunctionError } from '../db/errors.js';
import * as fn from '../db/functions.js';
import { AppError } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';

const DAY_MS = 86_400_000;
/** An India calendar day → the instant it starts. */
const istDay = (d: string) => new Date(`${d}T00:00:00+05:30`);
/** Delivered COD orders whose cash the courier has not paid out (collected, or refunded after collection, not remitted). */
const OUTSTANDING: Prisma.OrderWhereInput = { paymentMethod: 'COD', fulfilmentStatus: 'DELIVERED', paymentStatus: { in: ['COD_COLLECTED', 'PARTIALLY_REFUNDED', 'REFUNDED'] }, codRemittanceItem: null };

export class CodService {
  constructor(private readonly prisma: PrismaClient) {}

  async outstanding(q: z.output<typeof codOutstandingQuery>, now = new Date()) {
    const cutoff = new Date(now.getTime() - COD_OVERDUE_DAYS * DAY_MS);
    const where: Prisma.OrderWhereInput = {
      ...OUTSTANDING,
      ...(q.courier || q.overdue ? { shipment: { ...(q.courier ? { courierName: { equals: q.courier, mode: 'insensitive' as const } } : {}), ...(q.overdue ? { deliveredAt: { lt: cutoff } } : {}) } } : {}),
    };
    const [total, rows, sum, overdue] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({ where, include: { shipment: { select: { courierName: true, awbNumber: true, deliveredAt: true } } }, orderBy: [{ shipment: { deliveredAt: 'asc' } }, { id: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
      this.prisma.order.aggregate({ where: OUTSTANDING, _sum: { total: true }, _count: true }),
      this.prisma.order.aggregate({ where: { ...OUTSTANDING, shipment: { deliveredAt: { lt: cutoff } } }, _sum: { total: true }, _count: true }),
    ]);
    const data: CodOutstandingRow[] = rows.map((o) => {
      const days = o.shipment?.deliveredAt ? Math.floor((now.getTime() - o.shipment.deliveredAt.getTime()) / DAY_MS) : 0;
      return { orderId: o.id, orderNumber: o.orderNumber, customerName: o.shipName, courierName: o.shipment?.courierName ?? null, awbNumber: o.shipment?.awbNumber ?? null,
        total: o.total, deliveredAt: o.shipment?.deliveredAt?.toISOString() ?? null, days, overdue: days >= COD_OVERDUE_DAYS };
    });
    const summary: CodOutstandingSummary = { count: sum._count, total: sum._sum.total ?? 0, overdueCount: overdue._count, overdueTotal: overdue._sum.total ?? 0 };
    return { data, summary, meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) } };
  }

  async list(q: z.output<typeof codRemittanceListQuery>) {
    const [total, rows] = await Promise.all([
      this.prisma.codRemittance.count(),
      this.prisma.codRemittance.findMany({ include: { items: { include: { order: { select: { orderNumber: true, total: true } } }, orderBy: { orderId: 'asc' } } }, orderBy: [{ remittedAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    const staff = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.recordedBy).filter((x): x is number => x !== null))] } }, select: { id: true, name: true, email: true } });
    return { data: rows.map((r) => this.view(r, staff)), meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) } };
  }

  private view(r: Prisma.CodRemittanceGetPayload<{ include: { items: { include: { order: { select: { orderNumber: true; total: true } } } } } }>, staff: { id: number; name: string | null; email: string }[]): CodRemittanceRow {
    const who = staff.find((u) => u.id === r.recordedBy);
    return {
      id: r.id, courierName: r.courierName, reference: r.reference, amount: r.amount, remittedAt: r.remittedAt.toISOString(), note: r.note, recordedBy: who ? (who.name ?? who.email) : null, createdAt: r.createdAt.toISOString(),
      orders: r.items.map((i) => ({ orderId: i.orderId, orderNumber: i.order.orderNumber, amount: i.amount, expected: i.order.total })),
    };
  }

  /** Records the payout (audited in the same transaction). Refusals land on the field they belong to. */
  async record(b: z.output<typeof codRemittanceBody>, actorId: number, audit: (tx: Prisma.TransactionClient, after: unknown) => Promise<void>): Promise<CodRemittanceResult> {
    const field = (path: string, message: string) => new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path, message }]);
    if (istDay(b.remittedAt).getTime() > Date.now()) throw field('remittedAt', 'The payout date can’t be in the future');
    const orders = await this.prisma.order.findMany({ where: { orderNumber: { in: b.orders.map((o) => o.orderNumber) } }, select: { id: true, orderNumber: true } });
    const idOf = new Map(orders.map((o) => [o.orderNumber, o.id]));
    b.orders.forEach((o, n) => { if (!idOf.has(o.orderNumber)) throw field(`orders.${n}.orderNumber`, 'No order with this number'); });
    try {
      const r = await this.prisma.$transaction(async (tx) => {
        const out = await fn.recordCodRemittance(tx, { courierName: b.courierName, reference: b.reference, remittedAt: istDay(b.remittedAt), amount: b.amount, note: b.note, items: b.orders.map((o) => ({ orderId: idOf.get(o.orderNumber)!, amount: o.amount })), actorId });
        await audit(tx, { ...b, remittanceId: out.remittance_id, mismatches: out.mismatches });
        return out;
      });
      const row = await this.prisma.codRemittance.findUniqueOrThrow({ where: { id: r.remittance_id }, include: { items: { include: { order: { select: { orderNumber: true, total: true } } }, orderBy: { orderId: 'asc' } } } });
      const staff = await this.prisma.user.findMany({ where: { id: actorId }, select: { id: true, name: true, email: true } });
      const numberOf = new Map(orders.map((o) => [o.id, o.orderNumber]));
      return { remittance: this.view(row, staff), mismatches: r.mismatches.map((m) => ({ orderNumber: numberOf.get(m.order_id)!, expected: m.expected, remitted: m.remitted })) };
    } catch (e) {
      if (e instanceof DbFunctionError && e.code === 'COD_REMITTANCE_INVALID') {
        const [what, id] = (e.detail ?? '').split(':');
        if (what === 'reference') throw field('reference', `This ${b.courierName} payout reference is already recorded`);
        if (what === 'total') throw field('amount', 'The orders must add up to the amount paid');
        if (what === 'order') {
          const n = b.orders.findIndex((o) => idOf.get(o.orderNumber) === Number(id));
          throw field(`orders.${n}.orderNumber`, 'Not a delivered cash-on-delivery order waiting for its cash (already remitted, not delivered, or paid online)');
        }
      }
      // Two payouts recorded at the same moment: the unique keys (reference, order) let only one through.
      if (e instanceof Error && /duplicate key|23505/.test(e.message)) throw new AppError(409, 'CONFLICT', 'Another payout for one of these orders, or with this reference, was just recorded. Reload and check.');
      throw e;
    }
  }
}

/** Daily: COD cash outstanding longer than COD_OVERDUE_DAYS → one staff email per day. */
export async function codOverdueCheck(prisma: PrismaClient, now = new Date()): Promise<'NONE' | 'NOTIFIED' | 'ALREADY_NOTIFIED'> {
  const cutoff = new Date(now.getTime() - COD_OVERDUE_DAYS * DAY_MS);
  const agg = await prisma.order.aggregate({ where: { ...OUTSTANDING, shipment: { deliveredAt: { lt: cutoff } } }, _sum: { total: true }, _count: true });
  if (agg._count === 0) return 'NONE';
  const day = new Date(now.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('cod-overdue'))`;
    const seen = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'cod.remittance_overdue' AND aggregate_id = ${day}`;
    if (seen[0]!.n > 0) return 'ALREADY_NOTIFIED' as const;
    await fn.emit(tx, { aggregateType: 'cod', aggregateId: day, type: 'cod.remittance_overdue', payload: { count: agg._count, total: agg._sum.total ?? 0, days: COD_OVERDUE_DAYS }, consumers: ['email.admin'] });
    return 'NOTIFIED' as const;
  });
}

type AdminRoutes = { routes: Router; can: (p: Permission) => RequestHandler };

export function registerCodRoutes(admin: AdminRoutes, prisma: PrismaClient, service = new CodService(prisma)): void {
  const r = admin.routes;
  const remit = admin.can('cod:remit');
  const noStore = (res: Response) => res.set('Cache-Control', 'private, no-store');
  r.get('/cod/outstanding', remit, validate({ query: codOutstandingQuery }), async (req, res) => { noStore(res).json(await service.outstanding(req.query as unknown as z.output<typeof codOutstandingQuery>)); });
  r.get('/cod-remittances', remit, validate({ query: codRemittanceListQuery }), async (req, res) => { noStore(res).json(await service.list(req.query as unknown as z.output<typeof codRemittanceListQuery>)); });
  r.post('/cod-remittances', remit, validate({ body: codRemittanceBody }), async (req: Request, res: Response) => {
    const out = await service.record(req.body as z.output<typeof codRemittanceBody>, req.auth!.userId,
      (tx, after) => recordAudit(tx, req, res, { action: 'cod.remittance.create', entity: 'cod_remittance', entityId: (after as { remittanceId: number }).remittanceId, after }));
    res.status(201);
    noStore(res).json(out);
  });
}
