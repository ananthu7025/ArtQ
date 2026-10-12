// Restock Requests (task 5.9; api.md §4.8, database.md §3 "stock_notifications") [restock:read; notify restock:notify].
// Customers ask "Notify me" on a sold-out size (task 3.5); staff see who is waiting, grouped by variant. When a variant
// comes back (available 0 → > 0 inside a stock transaction, the aq_* functions emit `variant.back_in_stock`) or staff
// press "Notify now" (at most once per variant per India day), the `restock.notify` consumer emails every waiting
// customer once (each request → NOTIFIED with its own email event) while the variant is still available and live.
import { maskContact, restockListQuery, restockNotifyBody, type Permission, type RestockGroup, type RestockRequestRow } from '@artq/shared';
import { can } from '@artq/shared';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Request, RequestHandler, Response, Router } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';
import { recordAudit } from '../admin/router.js';
import * as fn from '../db/functions.js';
import { AppError } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { loadDelivery } from '../outbox/consume.js';

const istDay = (d = new Date()) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);

export class RestockService {
  constructor(private readonly prisma: PrismaClient) {}

  async groups(q: z.output<typeof restockListQuery>) {
    const text = q.q ? `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
    const filter = Prisma.sql`n.status = 'PENDING' ${text ? Prisma.sql`AND (p.name ILIKE ${text} OR v.sku ILIKE ${text})` : Prisma.empty} ${q.available ? Prisma.sql`AND v.on_hand - v.reserved > 0` : Prisma.empty}`;
    const [{ n }] = await this.prisma.$queryRaw<{ n: number }[]>`SELECT count(DISTINCT n.variant_id)::int AS n FROM stock_notifications n JOIN product_variants v ON v.id = n.variant_id JOIN products p ON p.id = n.product_id WHERE ${filter}` as [{ n: number }];
    const rows = await this.prisma.$queryRaw<{ variant_id: number; sku: string; label: string; product_id: number; name: string; status: string; pending: number; oldest: Date; available: number; today: boolean }[]>`
      SELECT n.variant_id, v.sku, v.label, p.id AS product_id, p.name, p.status::text, count(*)::int AS pending, min(n.created_at) AS oldest, (v.on_hand - v.reserved)::int AS available,
             EXISTS (SELECT 1 FROM outbox_events e WHERE e.event_type = 'variant.back_in_stock' AND e.aggregate_id = n.variant_id::text AND e.payload->>'manual_day' = ${istDay()}) AS today
        FROM stock_notifications n JOIN product_variants v ON v.id = n.variant_id JOIN products p ON p.id = n.product_id
       WHERE ${filter}
       GROUP BY n.variant_id, v.sku, v.label, p.id, p.name, p.status, v.on_hand, v.reserved
       ORDER BY (v.on_hand - v.reserved > 0) DESC, count(*) DESC, min(n.created_at) ASC
       OFFSET ${(q.page - 1) * q.limit}::int LIMIT ${q.limit}::int`;
    const data: RestockGroup[] = rows.map((r) => ({ variantId: r.variant_id, sku: r.sku, label: r.label, product: { id: r.product_id, name: r.name, status: r.status }, pending: r.pending, oldestAt: r.oldest.toISOString(), available: r.available, notifiedToday: r.today }));
    return { data, meta: { page: q.page, limit: q.limit, total: n, totalPages: Math.max(1, Math.ceil(n / q.limit)) } };
  }

  async requests(variantId: number, seeContact: boolean): Promise<RestockRequestRow[]> {
    const rows = await this.prisma.stockNotification.findMany({ where: { variantId, status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 500 });
    return rows.map((r) => ({ id: r.id, email: seeContact ? r.email : maskContact(r.email), customerId: r.userId, createdAt: r.createdAt.toISOString() }));
  }

  /** "Notify now": only while the variant is available and live; once per variant per India day. */
  async notifyNow(variantId: number, audit: (tx: Prisma.TransactionClient) => Promise<void>): Promise<{ queued: boolean; pending: number }> {
    const day = istDay();
    return this.prisma.$transaction(async (tx) => {
      const [v] = await tx.$queryRaw<{ available: number; status: string }[]>`
        SELECT (v.on_hand - v.reserved)::int AS available, p.status::text FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ${variantId} FOR NO KEY UPDATE OF v`;
      if (!v) throw new AppError(404, 'NOT_FOUND', 'Variant not found');
      if (v.available <= 0 || v.status !== 'ACTIVE') throw new AppError(422, 'NOT_AVAILABLE', 'This size isn’t available to buy yet, so customers can’t be told it’s back. Add stock (and publish the product) first.');
      const pending = await tx.stockNotification.count({ where: { variantId, status: 'PENDING' } });
      if (pending === 0) throw new AppError(422, 'NOTHING_TO_NOTIFY', 'Nobody is waiting for this size any more.');
      const [{ n }] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'variant.back_in_stock' AND aggregate_id = ${String(variantId)} AND payload->>'manual_day' = ${day}` as [{ n: number }];
      if (n > 0) { await audit(tx); return { queued: false, pending }; }      // already sent today: nothing new
      await fn.emit(tx, { aggregateType: 'variant', aggregateId: String(variantId), type: 'variant.back_in_stock', payload: { variant_id: variantId, manual_day: day }, consumers: ['restock.notify'] });
      await audit(tx);
      return { queued: true, pending };
    });
  }

  async cancel(id: number, audit: (tx: Prisma.TransactionClient) => Promise<void>) {
    await this.prisma.$transaction(async (tx) => {
      const n = await tx.stockNotification.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      if (n.count !== 1) {
        if (!(await tx.stockNotification.findUnique({ where: { id }, select: { id: true } }))) throw new AppError(404, 'NOT_FOUND', 'Request not found');
        throw new AppError(422, 'INVALID_TRANSITION', 'This request was already notified or removed.');
      }
      await audit(tx);
    });
  }
}

/**
 * Outbox consumer `restock.notify` (on variant.back_in_stock): while the variant is available and its product live,
 * every PENDING request becomes NOTIFIED and gets its own `restock.email` event (email.customer), in one transaction
 * with the delivery's completion, so a redelivery never emails anyone twice. Otherwise the requests keep waiting.
 */
export async function processRestockNotify(d: { prisma: PrismaClient; log: Logger }, deliveryId: number): Promise<'NOTIFIED' | 'NOT_AVAILABLE' | 'ALREADY_DONE'> {
  return d.prisma.$transaction(async (tx) => {
    if (!(await fn.outboxBeginConsume(tx, deliveryId))) return 'ALREADY_DONE' as const;
    const ev = await loadDelivery(tx, deliveryId);
    if (!ev) return 'ALREADY_DONE' as const;
    const variantId = Number((ev.payload as { variant_id?: unknown } | null)?.variant_id);
    const [v] = await tx.$queryRaw<{ available: number; status: string; name: string; slug: string; label: string; sku: string }[]>`
      SELECT (v.on_hand - v.reserved)::int AS available, p.status::text, p.name, p.slug, v.label, v.sku
        FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ${variantId}`;
    let out: 'NOTIFIED' | 'NOT_AVAILABLE' = 'NOT_AVAILABLE';
    if (v && v.available > 0 && v.status === 'ACTIVE') {
      const waiting = await tx.$queryRaw<{ id: number; email: string; user_id: number | null }[]>`
        UPDATE stock_notifications SET status = 'NOTIFIED', notified_at = now() WHERE variant_id = ${variantId} AND status = 'PENDING' RETURNING id, email::text, user_id`;
      for (const w of waiting) {
        await fn.emit(tx, { aggregateType: 'stock_notification', aggregateId: String(w.id), type: 'restock.email', payload: { to: w.email, user_id: w.user_id, product: v.name, label: v.label, slug: v.slug, sku: v.sku }, consumers: ['email.customer'] });
      }
      d.log.info({ variantId, notified: waiting.length }, 'back in stock: customers notified');
      out = 'NOTIFIED';
    }
    await fn.outboxComplete(tx, deliveryId);
    return out;
  });
}

type AdminRoutes = { routes: Router; can: (p: Permission) => RequestHandler };
const idParam = z.strictObject({ id: z.coerce.number().int().positive().max(2_147_483_647) });

export function registerRestockRoutes(admin: AdminRoutes, prisma: PrismaClient, service = new RestockService(prisma)): void {
  const r = admin.routes;
  const read = admin.can('restock:read');
  const notify = admin.can('restock:notify');
  const noStore = (res: Response) => res.set('Cache-Control', 'private, no-store');
  const id = (req: Request) => (req.params as unknown as { id: number }).id;
  r.get('/restock-requests', read, validate({ query: restockListQuery }), async (req, res) => { noStore(res).json(await service.groups(req.query as unknown as z.output<typeof restockListQuery>)); });
  r.get('/restock-requests/variants/:id', read, validate({ params: idParam }), async (req, res) => { noStore(res).json({ data: await service.requests(id(req), can(req.auth!.role, 'customers:write')) }); });
  r.post('/restock-requests/notify', notify, validate({ body: restockNotifyBody }), async (req, res) => {
    const variantId = (req.body as z.output<typeof restockNotifyBody>).variantId;
    noStore(res).json(await service.notifyNow(variantId, (tx) => recordAudit(tx, req, res, { action: 'restock.notify', entity: 'variant', entityId: variantId })));
  });
  r.delete('/restock-requests/:id', notify, validate({ params: idParam }), async (req, res) => {
    await service.cancel(id(req), (tx) => recordAudit(tx, req, res, { action: 'restock.cancel', entity: 'stock_notification', entityId: id(req) }));
    res.status(204).end();
  });
}
