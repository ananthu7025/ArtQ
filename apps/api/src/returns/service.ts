// Returns (task 5.5; product.md §8.8, api.md §3.5 and §4.7, database.md §8.5b). Every step is one aq_* function under
// the order lock (quantities, restock and refunds are bounded there); this service checks who may act, explains
// refusals on the field they belong to, and builds the views. Customer: request with photos (Idempotency-Key
// return.create). Staff: decide → in transit → receive → inspect (restocks sellable units) → refund → close, or cancel.
import {
  parseSetting, type AdminReturnDetail, type AdminReturnRow, type CustomerReturnView, type ReturnAction, type ReturnReason,
  type ReturnRequestStatus, type customerReturnBody, type returnDecideBody, type returnInspectBody, type returnListQuery, type returnReceiveBody, type returnRefundBody,
} from '@artq/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { z } from 'zod';
import { DbFunctionError } from '../db/errors.js';
import * as fn from '../db/functions.js';
import { AppError } from '../lib/errors.js';
import { refusal, RefundAdminService } from '../payments/refund-admin.js';
import { MIN_REFUND } from '../payments/refunds.js';

type Tx = Prisma.TransactionClient;
type Audit = (tx: Tx, e: { action: string; before?: unknown; after?: unknown }) => Promise<void>;
/** Signed link for a private photo (the media service checks the staff member may see it). */
export type PhotoUrl = (mediaId: number, rendition?: string) => Promise<string>;

const OPEN: ReturnRequestStatus[] = ['REQUESTED', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTED', 'REFUNDED'];
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** What staff can do with the return now (each step checks again under the lock). */
export function returnActions(r: { status: string; reason: string }, refundable: boolean): ReturnAction[] {
  const missing = r.reason === 'MISSING_ITEM';
  switch (r.status) {
    case 'REQUESTED': return ['decide', 'cancel'];
    case 'APPROVED': return missing ? ['refund', 'close', 'cancel'] : ['in-transit', 'receive', 'cancel'];
    case 'IN_TRANSIT': return ['receive', 'cancel'];
    case 'RECEIVED': return ['inspect'];
    case 'INSPECTED': return ['refund', 'close'];
    case 'REFUNDED': return refundable ? ['refund', 'close'] : ['close'];
    default: return [];
  }
}

/** Field the database's `RETURN_NOT_ALLOWED:<what>:<item>` refusal belongs to, per form. */
const FIELD: Record<string, string> = { quantity: 'quantity', approved: 'approvedQty', received: 'receivedQty', inspection: 'sellableQty' };
const MESSAGE: Record<string, string> = {
  quantity: 'That’s more than is left to return for this item (other return requests count too)',
  approved: 'Approve between 0 and the units requested',
  received: 'Enter between 0 and the units approved',
  inspection: 'Sellable and damaged units must add up to the units received',
};

/** Turns RETURN_NOT_ALLOWED / INVALID_TRANSITION into answers on the right field. */
function explain(e: unknown, items: { orderItemId: number }[] = [], windowHours?: number): never {
  if (e instanceof DbFunctionError && e.code === 'RETURN_NOT_ALLOWED') {
    const [what = '', id] = (e.detail ?? '').split(':');
    const n = id ? items.findIndex((i) => i.orderItemId === Number(id)) : -1;
    if (FIELD[what] && n >= 0) throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: `items.${n}.${FIELD[what]}`, message: MESSAGE[what]! }]);
    const text: Record<string, string> = {
      state: 'Returns can be requested once the order has been delivered.',
      window: `Returns must be requested within ${windowHours ?? 48} hours of delivery. Contact us and we’ll help.`,
      items: 'Choose each item once.',
      media: 'A photo is missing, still being processed, or already used on another request. Upload it again.',
      item: 'That item isn’t part of this return.',
      nothing_approved: 'Approve at least one unit, or reject the return.',
      missing_item: 'A missing item never comes back, so there is nothing to receive. Refund it instead.',
    };
    throw new AppError(422, 'RETURN_NOT_ALLOWED', text[what] ?? MESSAGE[what] ?? 'This return isn’t allowed.', { reason: what, ...(id ? { orderItemId: Number(id) } : {}) });
  }
  if (e instanceof DbFunctionError && e.code === 'INVALID_TRANSITION') throw new AppError(422, 'INVALID_TRANSITION', 'Someone else has already moved this return on. Reload to see where it is.');
  if (e instanceof DbFunctionError && e.code === 'NOT_FOUND') throw new AppError(404, 'NOT_FOUND', 'Return not found');
  throw e;
}

export class ReturnService {
  constructor(private readonly prisma: PrismaClient, private readonly refunds = new RefundAdminService(prisma)) {}

  async windowHours(db: PrismaClient | Tx = this.prisma): Promise<number> {
    const s = await db.setting.findUnique({ where: { key: 'ORDER' } });
    return s ? parseSetting('ORDER', s.value).returnWindowHours : 48;
  }

  // ── Customer ──
  /** Inside the idempotent request (ctx.tx). A TAKEOVER with the request already created returns that request. */
  async create(tx: Tx, orderId: number, userId: number | null, b: z.output<typeof customerReturnBody>): Promise<CustomerReturnView> {
    const hours = await this.windowHours(tx);
    let id: number;
    try {
      id = await fn.requestReturn(tx, { orderId, userId, reason: b.reason, description: b.description, items: b.items, mediaIds: b.mediaIds, windowHours: hours });
    } catch (e) { return explain(e, b.items, hours); }
    return this.customerView(id, tx);
  }

  async customerView(id: number, db: PrismaClient | Tx = this.prisma): Promise<CustomerReturnView> {
    const r = await db.returnRequest.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { orderItemId: 'asc' } } } });
    return { id: r.id, status: r.status, reason: r.reason as ReturnReason, items: r.items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.requestedQty })), createdAt: r.createdAt.toISOString() };
  }

  // ── Staff ──
  async list(q: z.output<typeof returnListQuery>) {
    const where: Prisma.ReturnRequestWhereInput = {
      ...(q.status ? { status: q.status } : q.open ? { status: { in: OPEN } } : {}),
      ...(q.orderId ? { orderId: q.orderId } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.returnRequest.count({ where }),
      this.prisma.returnRequest.findMany({ where, include: { items: true, order: { select: { orderNumber: true, shipName: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    return { data: rows.map((r) => this.row(r, true)), meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) } };
  }

  private row(r: Prisma.ReturnRequestGetPayload<{ include: { items: true; order: { select: { orderNumber: true; shipName: true } } } }>, refundable: boolean): AdminReturnRow {
    return {
      id: r.id, orderId: r.orderId, orderNumber: r.order.orderNumber, customerName: r.order.shipName, reason: r.reason as ReturnReason | 'OTHER', status: r.status,
      units: r.items.reduce((n, i) => n + i.requestedQty, 0), createdAt: r.createdAt.toISOString(), decidedAt: iso(r.decidedAt), actions: returnActions(r, refundable),
    };
  }

  async detail(id: number, photoUrl: PhotoUrl, db: PrismaClient | Tx = this.prisma): Promise<AdminReturnDetail> {
    const r = await db.returnRequest.findUnique({ where: { id }, include: {
      items: { include: { orderItem: true }, orderBy: { orderItemId: 'asc' } },
      order: { select: { orderNumber: true, shipName: true, paymentMethod: true, shippingFee: true, refundReservedShipping: true, shipment: { select: { deliveredAt: true } } } },
      media: { include: { media: { select: { id: true, renditions: true, status: true } } }, orderBy: { mediaId: 'asc' } },
      refunds: { orderBy: { id: 'asc' }, include: { items: true } },
    } });
    if (!r) throw new AppError(404, 'NOT_FOUND', 'Return not found');
    const decider = r.decidedBy ? await db.user.findUnique({ where: { id: r.decidedBy }, select: { name: true, email: true } }) : null;
    const missing = r.reason === 'MISSING_ITEM';
    const items = r.items.map((i) => {
      const used = r.refunds.filter((f) => !['FAILED', 'CANCELLED'].includes(f.status)).flatMap((f) => f.items).filter((x) => x.orderItemId === i.orderItemId).reduce((n, x) => n + x.quantity, 0);
      const base = (missing ? i.approvedQty : i.receivedQty) ?? 0;
      const refundableQty = ['INSPECTED', 'REFUNDED', ...(missing ? ['APPROVED'] : [])].includes(r.status) ? Math.max(0, base - used) : 0;
      const oi = i.orderItem;
      const refundableAmount = refundableQty === 0 ? 0 : Math.min(Math.ceil(oi.netAmount * refundableQty / oi.quantity), oi.netAmount - oi.refundReservedAmount);
      return {
        orderItemId: i.orderItemId, name: oi.productName, label: oi.variantLabel, sku: oi.sku, bought: oi.quantity, netAmount: oi.netAmount,
        requestedQty: i.requestedQty, approvedQty: i.approvedQty, receivedQty: i.receivedQty, sellableQty: i.sellableQty, damagedQty: i.damagedQty,
        refundedQty: used, refundableQty, refundableAmount: Math.max(0, refundableAmount),
      };
    });
    const photos = await Promise.all(r.media.filter((m) => m.media.status === 'READY').map(async (m) => {
      const renditions = (m.media.renditions ?? {}) as Record<string, string>;
      const thumb = renditions['320'] ? '320' : Object.keys(renditions)[0];
      return { id: m.mediaId, url: await photoUrl(m.mediaId), thumbUrl: thumb ? await photoUrl(m.mediaId, thumb) : null };
    }));
    const refundable = items.some((i) => i.refundableQty > 0);
    return {
      ...this.row({ ...r, items: r.items, order: r.order }, refundable),
      description: r.description, adminNote: r.adminNote, decidedBy: decider ? (decider.name ?? decider.email) : null,
      receivedAt: iso(r.receivedAt), inspectedAt: iso(r.inspectedAt), closedAt: iso(r.closedAt),
      deliveredAt: iso(r.order.shipment?.deliveredAt), paymentMethod: r.order.paymentMethod,
      items, photos,
      refunds: r.refunds.map((f) => ({ id: f.id, status: f.status, amount: f.amount, createdAt: f.createdAt.toISOString() })),
      shippingAvailable: r.order.shippingFee - r.order.refundReservedShipping,
    };
  }

  /** One staff step in its own transaction, audited in it. */
  private async step(id: number, items: { orderItemId: number }[], audit: Audit, action: string, after: unknown, work: (tx: Tx) => Promise<unknown>): Promise<void> {
    if (!(await this.prisma.returnRequest.findUnique({ where: { id }, select: { id: true } }))) throw new AppError(404, 'NOT_FOUND', 'Return not found');
    try {
      await this.prisma.$transaction(async (tx) => {
        const before = await tx.returnRequest.findUniqueOrThrow({ where: { id }, select: { status: true } });
        await work(tx);
        await audit(tx, { action, before, after });
      });
    } catch (e) { explain(e, items); }
  }

  decide(id: number, b: z.output<typeof returnDecideBody>, actorId: number, audit: Audit) {
    return this.step(id, b.items, audit, 'return.decide', b, (tx) => fn.decideReturn(tx, { returnId: id, approve: b.decision === 'APPROVE', items: b.decision === 'APPROVE' ? b.items : [], note: b.note, actorId }));
  }
  inTransit(id: number, note: string | null, actorId: number, audit: Audit) {
    return this.step(id, [], audit, 'return.in_transit', { note }, (tx) => fn.setReturnStatus(tx, { returnId: id, to: 'IN_TRANSIT', note, actorId }));
  }
  receive(id: number, b: z.output<typeof returnReceiveBody>, actorId: number, audit: Audit) {
    return this.step(id, b.items, audit, 'return.receive', b, (tx) => fn.receiveReturn(tx, { returnId: id, items: b.items, actorId }));
  }
  inspect(id: number, b: z.output<typeof returnInspectBody>, actorId: number, audit: Audit) {
    return this.step(id, b.items, audit, 'return.inspect', b, (tx) => fn.inspectReturn(tx, { returnId: id, items: b.items, actorId }));
  }
  close(id: number, note: string | null, actorId: number, audit: Audit) {
    return this.step(id, [], audit, 'return.close', { note }, (tx) => fn.setReturnStatus(tx, { returnId: id, to: 'CLOSED', note, actorId }));
  }
  cancel(id: number, note: string, actorId: number, audit: Audit) {
    return this.step(id, [], audit, 'return.cancel', { note }, (tx) => fn.setReturnStatus(tx, { returnId: id, to: 'CANCELLED', note, actorId }));
  }

  /** The RETURN refund, inside the idempotent request (capacity reserved there, or nothing written). */
  async refund(tx: Tx, id: number, b: z.output<typeof returnRefundBody>, key: string, actorId: number): Promise<{ refundId: number; method: string; status: string }> {
    const r = await tx.returnRequest.findUnique({ where: { id }, select: { orderId: true } });
    if (!r) throw new AppError(404, 'NOT_FOUND', 'Return not found');
    const view = await this.refunds.refundable(r.orderId);
    if (!view.method) throw new AppError(409, 'REFUND_PAYMENT_INVALID', view.blockedReason!);
    const items = b.items.filter((i) => i.amount > 0);
    const total = items.reduce((s, i) => s + i.amount, 0) + b.shippingAmount;
    if (view.method === 'ORIGINAL_PAYMENT' && total < MIN_REFUND) throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: '', message: 'Razorpay can’t refund less than ₹1' }]);
    const pay = view.method === 'ORIGINAL_PAYMENT' ? (await tx.payment.findFirstOrThrow({ where: { orderId: r.orderId, allocation: 'APPLIED' }, orderBy: { id: 'asc' }, select: { id: true } })).id : null;
    try {
      const refundId = await fn.requestReturnRefund(tx, { returnId: id, paymentId: pay, items, shipping: b.shippingAmount, reason: b.reason, idempotencyKey: `return-${key}`, actorId });
      return { refundId, method: view.method, status: 'REQUESTED' };
    } catch (e) {
      if (e instanceof DbFunctionError && (e.code === 'RETURN_NOT_ALLOWED' || e.code === 'INVALID_TRANSITION' || e.code === 'NOT_FOUND')) explain(e, b.items);
      if (e instanceof DbFunctionError && e.code === 'REFUND_EXCEEDS_CAPACITY' && e.detail?.startsWith('return:')) {
        const n = b.items.findIndex((i) => i.orderItemId === Number(e.detail!.split(':')[1]));
        if (n >= 0) throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: `items.${n}.amount`, message: 'More than this return allows for the item (units received, and their share of the price)' }]);
      }
      return refusal(e);
    }
  }
}
