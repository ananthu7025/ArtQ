// Admin refunds (task 5.4; api.md §4.7, architecture.md §10.2). refunds:create; creating, retrying and recording a
// bank transfer also need a recent password re-check (step-up, STEP_UP_PERMISSIONS). Every amount goes through the
// database functions, which reserve capacity at item, shipping, COD-fee, order and payment level: the service only
// chooses the payment, explains refusals and lists what is left.
//   GET  /admin/orders/:id/refundable        what can still be refunded (and why not, for COD not yet collected)
//   POST /admin/orders/:id/refunds           Idempotency-Key (op refund.create, target order:<id>) → 201
//   GET  /admin/refunds?status=&orderId=     queue, with attempts (key, receipt, last HTTP status)
//   POST /admin/refunds/:id/retry            FAILED online refunds: attempt n+1 with a new key and receipt
//   POST /admin/refunds/:id/manual-processed COD: the bank / UPI reference → PROCESSED
//   POST /admin/refunds/:id/cancel           COD refunds still REQUESTED → CANCELLED (capacity released)
// The invoice.credit_note consumer issues the credit note for a processed refund of an invoiced order.
import { buildCreditNoteContent, manualRefundBody, parseSetting, refundCreateBody, refundListQuery, type AdminRefundRow, type InvoiceLine, type InvoiceParty, type Permission, type RefundableView } from '@artq/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Request, RequestHandler, Response, Router } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';
import { recordAudit } from '../admin/router.js';
import { DbFunctionError } from '../db/errors.js';
import * as fn from '../db/functions.js';
import { idempotent } from '../idempotency/idempotency.js';
import { AppError } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { loadDelivery } from '../outbox/consume.js';
import { MIN_REFUND } from './refunds.js';

const SCOPE_TEXT: Record<string, string> = {
  item: 'more than is left to refund on an item (pending refunds count too)',
  order: 'more than is left to refund on the order, its shipping or its COD fee (pending refunds count too)',
  payment: 'more than is left on the payment (pending refunds count too)',
  return: 'more units of an item than this return received, or more than those units’ share of the price (refunds already made for this return count too)',
};

/** Turns the database's refusals into answers staff can act on. */
export function refusal(e: unknown): never {
  if (e instanceof DbFunctionError) {
    if (e.code === 'REFUND_EXCEEDS_CAPACITY') {
      const [scope, itemId] = (e.detail ?? '').split(':');
      throw new AppError(409, 'REFUND_EXCEEDS_CAPACITY', `This refunds ${SCOPE_TEXT[scope ?? ''] ?? 'more than is available'}. Reload to see what is left.`, { scope, ...(itemId ? { orderItemId: Number(itemId) } : {}) });
    }
    if (e.code === 'REFUND_RECONCILIATION_REQUIRED') throw new AppError(409, 'REFUND_RECONCILIATION_REQUIRED', 'Razorpay shows refunds on this payment that ArtQ has not recorded yet (made in the Razorpay dashboard?). They are being reconciled; try again in a few minutes.');
    if (e.code === 'REFUND_NOT_RETRYABLE') throw new AppError(409, 'REFUND_NOT_RETRYABLE', 'Only a failed online refund can be retried.');
    if (e.code === 'REFUND_NOT_CANCELLABLE') throw new AppError(409, 'REFUND_NOT_CANCELLABLE', 'Only a bank-transfer (COD) refund that has not been paid can be cancelled. Online refunds may already be with Razorpay.');
    if (e.code === 'REFUND_PAYMENT_INVALID') throw new AppError(409, 'REFUND_PAYMENT_INVALID', 'This order has no payment that can be refunded now.');
  }
  throw e;
}

type RefundWithAttempts = Prisma.RefundGetPayload<{ include: { attempts: true; order: { select: { orderNumber: true } } } }>;
function rowView(r: RefundWithAttempts): AdminRefundRow {
  const actions: AdminRefundRow['actions'] = [];
  if (r.status === 'FAILED' && r.method === 'ORIGINAL_PAYMENT') actions.push('retry');
  if (r.method === 'MANUAL_BANK' && r.status === 'REQUESTED') actions.push('manual-processed', 'cancel');
  return {
    id: r.id, orderId: r.orderId, orderNumber: r.order.orderNumber, kind: r.kind, method: r.method, status: r.status, amount: r.amount,
    itemsAmount: r.itemsAmount, shippingAmount: r.shippingAmount, codFeeAmount: r.codFeeAmount, reason: r.reason, failureReason: r.failureReason, manualReference: r.manualReference,
    createdAt: r.createdAt.toISOString(), sentAt: r.sentAt?.toISOString() ?? null, processedAt: r.processedAt?.toISOString() ?? null,
    attempts: r.attempts.sort((a, b) => a.attemptNo - b.attemptNo).map((a) => ({ no: a.attemptNo, key: a.providerIdempotencyKey, receipt: a.receipt, status: a.status, lastHttpStatus: a.lastHttpStatus, sendCount: a.sendCount })),
    actions,
  };
}

export class RefundAdminService {
  constructor(private readonly prisma: PrismaClient) {}

  async refundable(orderId: number): Promise<RefundableView> {
    const o = await this.prisma.order.findUnique({ where: { id: orderId }, include: { items: { orderBy: { id: 'asc' } }, payments: { where: { allocation: 'APPLIED' }, orderBy: { id: 'asc' }, take: 1 } } });
    if (!o) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    const pay = o.payments[0] ?? null;
    const cod = o.paymentMethod === 'COD';
    const method = cod ? (['COD_COLLECTED', 'COD_REMITTED', 'PARTIALLY_REFUNDED'].includes(o.paymentStatus) ? 'MANUAL_BANK' : null) : pay ? 'ORIGINAL_PAYMENT' : null;
    const blockedReason = method ? null : cod ? 'The cash hasn’t been collected yet, so there is nothing to refund. Cancel the order instead if it hasn’t shipped.' : 'This order has no completed payment to refund.';
    const cap = cod ? o.total : o.capturedAmount;
    return {
      orderId: o.id, orderNumber: o.orderNumber, method, blockedReason,
      items: o.items.map((i) => ({ orderItemId: i.id, name: i.productName, label: i.variantLabel, quantity: i.quantity, netAmount: i.netAmount, reservedQty: i.refundReservedQty, reservedAmount: i.refundReservedAmount,
        refundedQty: i.refundedQty, refundedAmount: i.refundedAmount, availableQty: i.quantity - i.refundReservedQty, availableAmount: i.netAmount - i.refundReservedAmount })),
      shipping: { fee: o.shippingFee, reserved: o.refundReservedShipping, available: o.shippingFee - o.refundReservedShipping },
      codFee: { fee: o.codFee, reserved: o.refundReservedCodFee, available: o.codFee - o.refundReservedCodFee },
      total: { cap, reserved: o.refundReservedTotal, refunded: o.refundedAmount, available: Math.max(0, cap - o.refundReservedTotal) },
      payment: pay ? { amount: pay.amount, reserved: pay.refundReserved, refunded: pay.amountRefunded, providerRefunded: pay.providerAmountRefunded, available: pay.amount - pay.refundReserved, reconciliationRequired: pay.providerAmountRefunded > pay.refundReserved } : null,
    };
  }

  async list(q: z.output<typeof refundListQuery>) {
    const where: Prisma.RefundWhereInput = { ...(q.status ? { status: q.status } : {}), ...(q.orderId ? { orderId: q.orderId } : {}) };
    const [total, rows] = await Promise.all([
      this.prisma.refund.count({ where }),
      this.prisma.refund.findMany({ where, include: { attempts: true, order: { select: { orderNumber: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    return { data: rows.map(rowView), meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) } };
  }

  private async one(id: number) {
    const r = await this.prisma.refund.findUnique({ where: { id }, include: { attempts: true, order: { select: { orderNumber: true } } } });
    if (!r) throw new AppError(404, 'NOT_FOUND', 'Refund not found');
    return rowView(r);
  }

  /** Creates the refund inside the idempotent request's transaction (capacity reserved there, or nothing written). */
  async create(tx: Prisma.TransactionClient, orderId: number, b: z.output<typeof refundCreateBody>, key: string, actorId: number): Promise<{ refundId: number; method: string; status: string; attempt: { no: number; receipt: string } | null }> {
    const view = await this.refundable(orderId);
    if (!view.method) throw new AppError(409, 'REFUND_PAYMENT_INVALID', view.blockedReason!);
    const total = b.items.reduce((s, i) => s + i.amount, 0) + b.shippingAmount + b.codFeeAmount;
    if (view.method === 'ORIGINAL_PAYMENT' && total < MIN_REFUND) throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: '', message: 'Razorpay can’t refund less than ₹1' }]);
    const items = await tx.orderItem.findMany({ where: { orderId, id: { in: b.items.map((i) => i.orderItemId) } }, select: { id: true, netAmount: true, taxAmount: true } });
    b.items.forEach((i, n) => { if (!items.some((x) => x.id === i.orderItemId)) throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: `items.${n}.orderItemId`, message: 'This item is not in the order' }]); });
    const pay = view.method === 'ORIGINAL_PAYMENT' ? (await tx.payment.findFirstOrThrow({ where: { orderId, allocation: 'APPLIED' }, orderBy: { id: 'asc' }, select: { id: true } })).id : null;
    try {
      const refundId = await fn.requestRefund(tx, {
        orderId, paymentId: pay, kind: b.kind, shipping: b.shippingAmount, codFee: b.codFeeAmount, unallocated: 0, reason: b.reason, idempotencyKey: `admin-${key}`, requestedBy: actorId,
        items: b.items.filter((i) => i.amount > 0).map((i) => { const it = items.find((x) => x.id === i.orderItemId)!; return { orderItemId: i.orderItemId, quantity: i.quantity, amount: i.amount, taxAmount: it.netAmount ? Math.round(it.taxAmount * i.amount / it.netAmount) : 0 }; }),
      });
      const a = await tx.refundAttempt.findFirst({ where: { refundId }, orderBy: { attemptNo: 'desc' }, select: { attemptNo: true, receipt: true } });
      return { refundId, method: view.method, status: 'REQUESTED', attempt: a ? { no: a.attemptNo, receipt: a.receipt } : null };
    } catch (e) { return refusal(e); }
  }

  async retry(id: number, audit: (tx: Prisma.TransactionClient) => Promise<void>): Promise<AdminRefundRow> {
    try { await this.prisma.$transaction(async (tx) => { await fn.retryRefund(tx, id); await audit(tx); }); } catch (e) { refusal(e); }
    return this.one(id);
  }

  async manualProcessed(id: number, reference: string, audit: (tx: Prisma.TransactionClient) => Promise<void>): Promise<AdminRefundRow> {
    await this.prisma.$transaction(async (tx) => {
      const n = await tx.refund.updateMany({ where: { id, method: 'MANUAL_BANK', status: 'REQUESTED' }, data: { manualReference: reference } });
      if (n.count !== 1) {
        if (!(await tx.refund.findUnique({ where: { id }, select: { id: true } }))) throw new AppError(404, 'NOT_FOUND', 'Refund not found');
        throw new AppError(409, 'REFUND_NOT_MANUAL', 'Only a bank-transfer (COD) refund that has not been recorded yet can be marked paid.');
      }
      await fn.markRefundProcessed(tx, id, null);
      await audit(tx);
    });
    return this.one(id);
  }

  async cancel(id: number, audit: (tx: Prisma.TransactionClient) => Promise<void>): Promise<AdminRefundRow> {
    if (!(await this.prisma.refund.findUnique({ where: { id }, select: { id: true } }))) throw new AppError(404, 'NOT_FOUND', 'Refund not found');
    try { await this.prisma.$transaction(async (tx) => { await fn.cancelManualRefund(tx, id); await audit(tx); }); } catch (e) { refusal(e); }
    return this.one(id);
  }

  /** The credit note for a processed refund (invoice.credit_note consumer); SKIPPED when none is due. */
  async creditNote(refundId: number, now = new Date()) {
    const r = await this.prisma.refund.findUnique({ where: { id: refundId }, include: { items: { include: { orderItem: true } } } });
    if (!r) throw new TypeError(`refund ${refundId} not found`);
    const original = await this.prisma.invoice.findFirst({ where: { orderId: r.orderId, kind: 'TAX_INVOICE' } });
    if (!original || r.status !== 'PROCESSED' || r.itemsAmount + r.shippingAmount + r.codFeeAmount === 0) return { status: 'SKIPPED' as const };
    const store = await this.prisma.setting.findUnique({ where: { key: 'STORE_INFO' } });
    const content = buildCreditNoteContent(
      { seller: original.sellerSnapshot as unknown as InvoiceParty, buyer: original.buyerSnapshot as unknown as InvoiceParty, place_of_supply: original.placeOfSupply, lines: original.lines as unknown as InvoiceLine[] },
      { items: r.items.map((i) => ({ description: i.orderItem.variantLabel ? `${i.orderItem.productName} (${i.orderItem.variantLabel})` : i.orderItem.productName, sku: i.orderItem.sku, hsn: i.orderItem.hsnCode, quantity: i.quantity, amount: i.amount, ratePercent: Number(i.orderItem.taxRate) })), shipping: r.shippingAmount, codFee: r.codFeeAmount },
      { storeStateCode: store ? parseSetting('STORE_INFO', store.value).stateCode : '32', at: now },
    );
    return this.prisma.$transaction((tx) => fn.issueCreditNote(tx, { refundId, content, actorId: null }));
  }
}

/** Outbox consumer `invoice.credit_note` (on refund.processed). */
export async function processCreditNote(d: { prisma: PrismaClient; refunds: RefundAdminService; log: Logger }, deliveryId: number): Promise<string> {
  const ev = await d.prisma.$transaction(async (tx) => ((await fn.outboxBeginConsume(tx, deliveryId)) ? loadDelivery(tx, deliveryId) : null));
  if (!ev) return 'ALREADY_DONE';
  const refundId = Number((ev.payload as { refund_id?: unknown } | null)?.refund_id);
  if (!Number.isSafeInteger(refundId) || refundId <= 0) throw new TypeError(`refund.processed event ${ev.eventId} has no refund_id`);
  const r = await d.refunds.creditNote(refundId);
  await d.prisma.$transaction(async (tx) => { if (await fn.outboxBeginConsume(tx, deliveryId)) await fn.outboxComplete(tx, deliveryId); });
  return r.status;
}

type AdminRoutes = { routes: Router; can: (p: Permission, o?: { stepUp?: boolean }) => RequestHandler };
const idParam = z.strictObject({ id: z.coerce.number().int().positive().max(2_147_483_647) });

export function registerRefundRoutes(admin: AdminRoutes, prisma: PrismaClient, log: Logger, service = new RefundAdminService(prisma)): void {
  const r = admin.routes;
  const view = admin.can('refunds:create', { stepUp: false });
  const act = admin.can('refunds:create');                       // + recent password re-check
  const noStore = (res: Response) => res.set('Cache-Control', 'private, no-store');
  const id = (req: Request) => (req.params as unknown as { id: number }).id;
  const audit = (req: Request, res: Response, action: string, after?: unknown) => (tx: Prisma.TransactionClient) => recordAudit(tx, req, res, { action, entity: 'refund', entityId: id(req), after });

  r.get('/orders/:id/refundable', view, validate({ params: idParam }), async (req, res) => { noStore(res).json(await service.refundable(id(req))); });
  r.post('/orders/:id/refunds', act, validate({ params: idParam, body: refundCreateBody }), idempotent({ prisma, log }, {
    operation: 'refund.create', scope: (req) => `staff:${req.auth!.userId}`, target: (req) => `order:${id(req)}`,
  }, async (req, ctx) => {
    const b = req.body as z.output<typeof refundCreateBody>;
    const out = await ctx.tx(async (tx) => {
      const created = await service.create(tx, id(req), b, ctx.key, req.auth!.userId);
      await ctx.attach(tx, 'refund', String(created.refundId));
      await recordAudit(tx, req, req.res as Response, { action: 'refund.create', entity: 'refund', entityId: created.refundId, after: { orderId: id(req), ...b, method: created.method } });
      return created;
    });
    return { status: 201, body: out, resource: { type: 'refund', id: String(out.refundId) } };
  }));
  r.get('/refunds', view, validate({ query: refundListQuery }), async (req, res) => { noStore(res).json(await service.list(req.query as unknown as z.output<typeof refundListQuery>)); });
  r.post('/refunds/:id/retry', act, validate({ params: idParam }), async (req, res) => { res.status(202); noStore(res).json(await service.retry(id(req), audit(req, res, 'refund.retry'))); });
  r.post('/refunds/:id/manual-processed', act, validate({ params: idParam, body: manualRefundBody }), async (req, res) => {
    const ref = (req.body as z.output<typeof manualRefundBody>).manualReference;
    noStore(res).json(await service.manualProcessed(id(req), ref, audit(req, res, 'refund.manual_processed', { manualReference: ref })));
  });
  r.post('/refunds/:id/cancel', view, validate({ params: idParam }), async (req, res) => { noStore(res).json(await service.cancel(id(req), audit(req, res, 'refund.cancel'))); });
}
