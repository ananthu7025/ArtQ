// Admin Orders (task 5.1; api.md §4.3, database.md §3.9 and §4.2–4.4). The list with its four status dimensions, the
// detail, the fulfilment transitions staff make by hand (confirm, pack, out for delivery, delivered), the delivery
// address correction and staff note, and sending a customer email again.
//
// Every transition is one conditional UPDATE (the order row is the lock, database.md §4.1), so two people pressing the
// same button change the order once and the second gets INVALID_TRANSITION. Each change writes order_status_history,
// bumps `version`, is audited, and (confirm, deliver) emits `order.status_changed` for the customer email.
// Ship (dispatch: stock and invoice) is in dispatch.ts (task 5.2); cancellation 5.3, RTO and lost 5.6.
import {
  maskContact, parseSetting, type orderAddressBody, type orderPatchBody, surfaceAvailable, type AdminOrderDetail, type AdminOrderRow, type OrderAction, type ResendableEmail, type adminOrderListQuery,
} from '@artq/shared';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { z } from 'zod';
import * as fn from '../db/functions.js';
import { AppError } from '../lib/errors.js';
import { destinationFor } from '../shipping/destination.js';

type Tx = Prisma.TransactionClient;
export type Actor = { userId: number; seeContact: boolean; audit: (db: Tx, e: { action: string; entity: string; entityId: string | number; before?: unknown; after?: unknown }) => Promise<void> };

const FULFILLABLE_PAYMENT = ['PAID', 'COD_PENDING'];
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

type OrderState = { status: string; paymentStatus: string; fulfilmentStatus: string };
/** What staff can do now (the transition itself checks again under the lock). */
export function actionsFor(o: OrderState): OrderAction[] {
  const a: OrderAction[] = [];
  const paid = FULFILLABLE_PAYMENT.includes(o.paymentStatus);
  if (o.status === 'PLACED' && paid) a.push('confirm');
  if (o.status === 'CONFIRMED' && o.fulfilmentStatus === 'UNFULFILLED' && paid) a.push('pack');
  if (o.status === 'CONFIRMED' && o.fulfilmentStatus === 'PACKED' && paid) a.push('ship');
  if (o.status === 'CONFIRMED' && o.fulfilmentStatus === 'SHIPPED') a.push('out-for-delivery');
  if (o.status === 'CONFIRMED' && ['SHIPPED', 'OUT_FOR_DELIVERY'].includes(o.fulfilmentStatus)) a.push('deliver');
  if (['PLACED', 'CONFIRMED'].includes(o.status) && o.fulfilmentStatus === 'UNFULFILLED') a.push('edit-address');
  if (o.status === 'PENDING_PAYMENT' || (['PLACED', 'CONFIRMED'].includes(o.status) && ['UNFULFILLED', 'PACKED'].includes(o.fulfilmentStatus))) a.push('cancel');
  return a;
}
export function resendableFor(o: OrderState): ResendableEmail[] {
  const r: ResendableEmail[] = [];
  if (['PLACED', 'CONFIRMED', 'COMPLETED'].includes(o.status)) r.push('order_placed');
  if (['CONFIRMED', 'COMPLETED'].includes(o.status)) r.push('order_confirmed');
  if (['SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(o.fulfilmentStatus)) r.push('order_shipped');
  if (o.fulfilmentStatus === 'DELIVERED') r.push('order_delivered');
  return r;
}

const LIST_SELECT = {
  id: true, orderNumber: true, createdAt: true, placedAt: true, userId: true, contactEmail: true, contactPhone: true, shipName: true, shipCity: true, shipPincode: true,
  total: true, paymentMethod: true, status: true, paymentStatus: true, fulfilmentStatus: true, returnStatus: true, hasOpenException: true,
  items: { select: { quantity: true } },
} satisfies Prisma.OrderSelect;
type ListRow = Prisma.OrderGetPayload<{ select: typeof LIST_SELECT }>;

function rowView(o: ListRow, seeContact: boolean): AdminOrderRow {
  return {
    id: o.id, orderNumber: o.orderNumber, createdAt: o.createdAt.toISOString(), placedAt: iso(o.placedAt),
    customer: { name: o.shipName, email: seeContact ? o.contactEmail : maskContact(o.contactEmail), phone: seeContact ? o.contactPhone : maskContact(o.contactPhone), city: o.shipCity, pincode: o.shipPincode, isGuest: o.userId === null },
    itemCount: o.items.reduce((n, i) => n + i.quantity, 0), total: o.total, paymentMethod: o.paymentMethod,
    status: o.status, paymentStatus: o.paymentStatus, fulfilmentStatus: o.fulfilmentStatus, returnStatus: o.returnStatus, hasOpenException: o.hasOpenException,
  };
}

/** A calendar day in India (UTC+5:30) → its first instant. */
const istDay = (d: string) => new Date(`${d}T00:00:00+05:30`);

export class AdminOrderService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(q: z.output<typeof adminOrderListQuery>, seeContact: boolean) {
    const text = q.q?.trim();
    const digits = text?.replace(/\D/g, '') ?? '';
    const where: Prisma.OrderWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.paymentStatus ? { paymentStatus: q.paymentStatus } : {}),
      ...(q.fulfilmentStatus ? { fulfilmentStatus: q.fulfilmentStatus } : {}),
      ...(q.returnStatus ? { returnStatus: q.returnStatus } : {}),
      ...(q.method ? { paymentMethod: q.method } : {}),
      ...(q.exception ? { hasOpenException: true } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: istDay(q.from) } : {}), ...(q.to ? { lt: new Date(istDay(q.to).getTime() + 86_400_000) } : {}) } } : {}),
      ...(text ? { OR: [
        { orderNumber: { contains: text, mode: 'insensitive' } },
        { contactEmail: { contains: text, mode: 'insensitive' } },
        { shipName: { contains: text, mode: 'insensitive' } },
        ...(digits.length >= 4 ? [{ contactPhone: { contains: digits.slice(-10) } }, { shipPhone: { contains: digits.slice(-10) } }] : []),
      ] } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({ where, select: LIST_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    return { data: rows.map((o) => rowView(o, seeContact)), meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) } };
  }

  async detail(id: number, seeContact: boolean, db: PrismaClient | Tx = this.prisma): Promise<AdminOrderDetail> {
    const o = await db.order.findUnique({ where: { id }, include: {
      items: { orderBy: { id: 'asc' } },
      paymentAttempts: { orderBy: { id: 'asc' } }, payments: { orderBy: { id: 'asc' } }, refunds: { orderBy: { id: 'asc' } },
      exceptions: { orderBy: { id: 'asc' } }, shipment: true, invoices: { orderBy: { id: 'asc' } },
      history: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    } });
    if (!o) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    const [state, emails, actors] = await Promise.all([
      o.shipStateCode ? db.state.findFirst({ where: { gstCode: o.shipStateCode }, select: { id: true } }) : null,
      db.emailLog.findMany({ where: { orderId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      db.user.findMany({ where: { id: { in: [...new Set(o.history.map((h) => h.actorId).filter((x): x is number => x !== null))] } }, select: { id: true, name: true, email: true } }),
    ]);
    const base = rowView({ ...o, items: o.items }, seeContact);
    return {
      ...base,
      version: o.version, contactMasked: !seeContact, contactEmailVerified: o.contactEmailVerifiedAt !== null, userId: o.userId,
      shippingAddress: { fullName: o.shipName, phone: o.shipPhone, line1: o.shipLine1, line2: o.shipLine2, landmark: o.shipLandmark, city: o.shipCity, state: o.shipState, stateId: state?.id ?? null, pincode: o.shipPincode },
      billing: { sameAsShipping: o.billSameAsShip, address: (o.billingSnapshot as Record<string, unknown> | null) ?? null, gstin: o.gstin, businessName: o.businessName },
      items: o.items.map((i) => ({ id: i.id, productId: i.productId, variantId: i.variantId, name: i.productName, label: i.variantLabel, sku: i.sku, imageUrl: i.imageUrl, unitPrice: i.unitPrice, quantity: i.quantity, lineTotal: i.lineTotal, discount: i.discount, netAmount: i.netAmount, taxRate: Number(i.taxRate), taxAmount: i.taxAmount, refundedQty: i.refundedQty, returnedQty: i.returnedQty })),
      totals: { subtotal: o.subtotal, mrpTotal: o.mrpTotal, couponDiscount: o.couponDiscount, couponCode: o.couponCode, shippingFee: o.shippingFee, codFee: o.codFee, total: o.total, taxTotal: o.taxTotal, capturedAmount: o.capturedAmount, refundedAmount: o.refundedAmount },
      weights: { actualG: o.actualWeightG, chargeableG: o.chargeableWeightG },
      notes: { customer: o.customerNote, admin: o.adminNote },
      times: { expiresAt: iso(o.expiresAt), confirmedAt: iso(o.confirmedAt), completedAt: iso(o.completedAt), cancelledAt: iso(o.cancelledAt), expiredAt: iso(o.expiredAt), cancelReason: o.cancelReason },
      attempts: o.paymentAttempts.map((a) => ({ id: a.id, receipt: a.receipt, providerOrderId: a.providerOrderId, amount: a.amount, status: a.status, createdAt: a.createdAt.toISOString() })),
      payments: o.payments.map((p) => ({ id: p.id, providerPaymentId: p.providerPaymentId, method: p.method, amount: p.amount, status: p.status, allocation: p.allocation, amountRefunded: p.amountRefunded, capturedAt: iso(p.capturedAt), createdAt: p.createdAt.toISOString() })),
      refunds: o.refunds.map((r) => ({ id: r.id, kind: r.kind, method: r.method, status: r.status, amount: r.amount, reason: r.reason, createdAt: r.createdAt.toISOString(), processedAt: iso(r.processedAt) })),
      exceptions: o.exceptions.map((e) => ({ id: e.id, type: e.type, status: e.status, amount: e.amount, createdAt: e.createdAt.toISOString(), resolvedAt: iso(e.resolvedAt) })),
      shipment: o.shipment ? { courierName: o.shipment.courierName, awbNumber: o.shipment.awbNumber, trackingUrl: o.shipment.trackingUrl, status: o.shipment.status, weightG: o.shipment.weightG, shippedAt: iso(o.shipment.shippedAt), deliveredAt: iso(o.shipment.deliveredAt) } : null,
      invoices: o.invoices.map((v) => ({ id: v.id, kind: v.kind, number: v.number, issuedAt: v.issuedAt.toISOString(), grandTotal: v.grandTotal })),
      history: o.history.map((h) => {
        const who = actors.find((u) => u.id === h.actorId);
        return { dimension: h.dimension, from: h.fromValue, to: h.toValue, note: h.note, actor: h.actorType, actorName: who ? (who.name ?? who.email) : null, at: h.createdAt.toISOString() };
      }),
      emails: emails.map((e) => ({ id: e.id, template: e.template, subject: e.subject, to: seeContact ? e.toEmail : maskContact(e.toEmail), status: e.status, at: e.createdAt.toISOString() })),
      actions: actionsFor(o),
      resendable: resendableFor(o),
    };
  }

  // ── Transitions ──
  /** PLACED (paid or COD) → CONFIRMED. */
  confirm(id: number, actor: Actor, notify: boolean) {
    return this.transition(id, actor, 'order.confirm', Prisma.sql`status = 'PLACED' AND payment_status IN ('PAID', 'COD_PENDING')`,
      Prisma.sql`status = 'CONFIRMED', confirmed_at = now()`, 'confirmed', notify ? 'CONFIRMED' : null);
  }
  /** CONFIRMED + UNFULFILLED (paid or COD) → PACKED. */
  pack(id: number, actor: Actor) {
    return this.transition(id, actor, 'order.pack', Prisma.sql`status = 'CONFIRMED' AND fulfilment_status = 'UNFULFILLED' AND payment_status IN ('PAID', 'COD_PENDING')`,
      Prisma.sql`fulfilment_status = 'PACKED'`, 'packed', null);
  }
  /** SHIPPED → OUT_FOR_DELIVERY (the shipment too). */
  outForDelivery(id: number, actor: Actor) {
    return this.transition(id, actor, 'order.out_for_delivery', Prisma.sql`status = 'CONFIRMED' AND fulfilment_status = 'SHIPPED'`,
      Prisma.sql`fulfilment_status = 'OUT_FOR_DELIVERY'`, 'marked out for delivery', null,
      (tx) => tx.$executeRaw`UPDATE shipments SET status = 'OUT_FOR_DELIVERY', updated_at = now() WHERE order_id = ${id}`);
  }
  /** SHIPPED / OUT_FOR_DELIVERY → DELIVERED; a COD order's cash is now collected (COD_PENDING → COD_COLLECTED). */
  deliver(id: number, actor: Actor, notify: boolean) {
    return this.transition(id, actor, 'order.deliver', Prisma.sql`status = 'CONFIRMED' AND fulfilment_status IN ('SHIPPED', 'OUT_FOR_DELIVERY')`,
      Prisma.sql`fulfilment_status = 'DELIVERED', payment_status = CASE WHEN payment_status = 'COD_PENDING' THEN 'COD_COLLECTED'::"OrderPaymentStatus" ELSE payment_status END`,
      'marked delivered', notify ? 'DELIVERED' : null,
      (tx) => tx.$executeRaw`UPDATE shipments SET status = 'DELIVERED', delivered_at = now(), updated_at = now() WHERE order_id = ${id}`);
  }

  private async transition(id: number, actor: Actor, action: string, when: Prisma.Sql, set: Prisma.Sql, verb: string, emailFor: 'CONFIRMED' | 'DELIVERED' | null, also?: (tx: Tx) => Promise<unknown>): Promise<AdminOrderDetail> {
    return this.prisma.$transaction(async (tx) => {
      const [before] = await tx.$queryRaw<(OrderState & { orderNumber: string })[]>`
        SELECT status::text AS status, payment_status::text AS "paymentStatus", fulfilment_status::text AS "fulfilmentStatus", order_number AS "orderNumber"
          FROM orders WHERE id = ${id} FOR NO KEY UPDATE`;
      if (!before) throw new AppError(404, 'NOT_FOUND', 'Order not found');
      const [after] = await tx.$queryRaw<OrderState[]>`
        UPDATE orders SET ${set}, version = version + 1, updated_at = now() WHERE id = ${id} AND ${when}
        RETURNING status::text AS status, payment_status::text AS "paymentStatus", fulfilment_status::text AS "fulfilmentStatus"`;
      if (!after) throw new AppError(422, 'INVALID_TRANSITION', `This order can’t be ${verb} now: it is ${describe(before)}. Reload to see its latest state.`, { current: before });
      for (const [dimension, k] of [['ORDER', 'status'], ['PAYMENT', 'paymentStatus'], ['FULFILMENT', 'fulfilmentStatus']] as const) {
        if (before[k] !== after[k]) await tx.$executeRaw`
          INSERT INTO order_status_history (order_id, dimension, from_value, to_value, actor_type, actor_id) VALUES (${id}, ${dimension}::"StatusDimension", ${before[k]}, ${after[k]}, 'ADMIN', ${actor.userId})`;
      }
      if (also) await also(tx);
      if (emailFor) await fn.emit(tx, { aggregateType: 'order', aggregateId: before.orderNumber, type: 'order.status_changed', payload: { order_id: id, to: emailFor }, consumers: ['email.customer'] });
      await actor.audit(tx, { action, entity: 'order', entityId: id, before, after: { ...after, notifyCustomer: emailFor !== null } });
      return this.detail(id, actor.seeContact, tx);
    });
  }

  // ── Address correction and staff note ──
  async patch(id: number, b: z.output<typeof orderPatchBody>, actor: Actor): Promise<AdminOrderDetail> {
    const place = b.shippingAddress ? await this.checkAddress(id, b.shippingAddress) : null;
    return this.prisma.$transaction(async (tx) => {
      const [o] = await tx.$queryRaw<(OrderState & { version: number })[]>`
        SELECT status::text AS status, payment_status::text AS "paymentStatus", fulfilment_status::text AS "fulfilmentStatus", version FROM orders WHERE id = ${id} FOR NO KEY UPDATE`;
      if (!o) throw new AppError(404, 'NOT_FOUND', 'Order not found');
      if (o.version !== b.version) throw new AppError(409, 'VERSION_CONFLICT', 'Someone else changed this order. Review the latest details and try again.', { current: await this.detail(id, actor.seeContact, tx) });
      const before = await tx.order.findUniqueOrThrow({ where: { id }, select: { shipName: true, shipPhone: true, shipLine1: true, shipLine2: true, shipLandmark: true, shipCity: true, shipState: true, shipStateCode: true, shipPincode: true, adminNote: true } });
      const data: Prisma.OrderUpdateInput = { version: { increment: 1 } };
      if (b.shippingAddress && place) {
        if (!actionsFor(o).includes('edit-address')) throw new AppError(422, 'INVALID_TRANSITION', `The delivery address can only change before the order is packed; it is ${describe(o)}.`, { current: o });
        const a = b.shippingAddress;
        Object.assign(data, { shipName: a.fullName, shipPhone: a.phone, shipLine1: a.line1, shipLine2: a.line2 ?? null, shipLandmark: a.landmark ?? null, shipCity: a.city, shipState: place.name, shipStateCode: place.gstCode, shipPincode: a.pincode });
      }
      if (b.adminNote !== undefined) data.adminNote = b.adminNote;
      await tx.order.update({ where: { id }, data });
      const after = await tx.order.findUniqueOrThrow({ where: { id }, select: { shipName: true, shipPhone: true, shipLine1: true, shipLine2: true, shipLandmark: true, shipCity: true, shipState: true, shipStateCode: true, shipPincode: true, adminNote: true } });
      await actor.audit(tx, { action: b.shippingAddress ? 'order.address.update' : 'order.note.update', entity: 'order', entityId: id, before, after });
      return this.detail(id, actor.seeContact, tx);
    });
  }

  /** The corrected address must be one checkout would accept for this order: a known pincode in the chosen state, delivered, with a rate, COD and road-only items still possible. */
  private async checkAddress(id: number, a: z.output<typeof orderAddressBody>) {
    const field = (path: string, message: string) => new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: `shippingAddress.${path}`, message }]);
    const [order, state, dest] = await Promise.all([
      this.prisma.order.findUnique({ where: { id }, select: { paymentMethod: true, items: { select: { variant: { select: { shippingClass: true } } } } } }),
      this.prisma.state.findFirst({ where: { id: a.stateId, isActive: true } }),
      destinationFor(this.prisma, a.pincode),
    ]);
    if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    if (!state) throw field('stateId', 'Choose a state');
    if (!dest.place) throw field('pincode', 'This pincode isn’t in the postal directory. Check the number.');
    if (dest.place.stateId !== state.id) throw field('pincode', `This pincode is in ${dest.place.state}`);
    if (!dest.serviceability.serviceable) throw field('pincode', 'We don’t deliver to this pincode');
    if (!dest.zone) throw field('pincode', 'There is no shipping rate for this pincode’s state');
    if (order.paymentMethod === 'COD' && !dest.serviceability.codAvailable) throw field('pincode', 'Cash on delivery isn’t available at this pincode');
    if (!surfaceAvailable(a.pincode, dest.settings.airOnlyPincodePrefixes) && order.items.some((i) => i.variant?.shippingClass === 'SURFACE_ONLY')) {
      throw field('pincode', 'Some items travel by road only and can’t be delivered to this pincode');
    }
    return state;
  }

  // ── Emails ──
  async resendEmail(id: number, template: ResendableEmail, actor: Actor): Promise<AdminOrderDetail> {
    return this.prisma.$transaction(async (tx) => {
      const [o] = await tx.$queryRaw<(OrderState & { orderNumber: string })[]>`
        SELECT status::text AS status, payment_status::text AS "paymentStatus", fulfilment_status::text AS "fulfilmentStatus", order_number AS "orderNumber" FROM orders WHERE id = ${id} FOR NO KEY UPDATE`;
      if (!o) throw new AppError(404, 'NOT_FOUND', 'Order not found');
      if (!resendableFor(o).includes(template)) throw new AppError(422, 'INVALID_TRANSITION', `That email doesn’t fit this order now: it is ${describe(o)}.`, { current: o });
      const [{ n }] = await tx.$queryRaw<[{ n: number }]>`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'order.email_resend' AND aggregate_id = ${o.orderNumber}`;
      await fn.emit(tx, { aggregateType: 'order', aggregateId: o.orderNumber, type: 'order.email_resend', payload: { order_id: id, template, resend: n + 1 }, consumers: ['email.customer'] });
      await actor.audit(tx, { action: 'order.email.resend', entity: 'order', entityId: id, after: { template, resend: n + 1 } });
      return this.detail(id, actor.seeContact, tx);
    });
  }

  /** What the packing slip prints. */
  async packingSlip(id: number) {
    const o = await this.prisma.order.findUnique({ where: { id }, include: { items: { orderBy: { id: 'asc' } } } });
    if (!o) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    if (!['PLACED', 'CONFIRMED', 'COMPLETED'].includes(o.status)) throw new AppError(422, 'INVALID_TRANSITION', `A packing slip is for a placed order; this one is ${describe(o)}.`);
    const store = await this.prisma.setting.findUnique({ where: { key: 'STORE_INFO' } });
    return { order: o, store: store ? parseSetting('STORE_INFO', store.value) : null };
  }
}

const WORDS: Record<string, string> = {
  PENDING_PAYMENT: 'awaiting payment', PLACED: 'placed', CONFIRMED: 'confirmed', COMPLETED: 'completed', CANCELLED: 'cancelled', EXPIRED: 'expired',
  UNFULFILLED: 'not packed', PACKED: 'packed', SHIPPED: 'shipped', OUT_FOR_DELIVERY: 'out for delivery', DELIVERED: 'delivered', RTO_IN_TRANSIT: 'returning to us', RTO_RECEIVED: 'returned to us', LOST: 'lost in transit',
  UNPAID: 'unpaid', PROCESSING: 'payment processing', PAID: 'paid', PARTIALLY_REFUNDED: 'partly refunded', REFUNDED: 'refunded', COD_PENDING: 'cash on delivery', COD_COLLECTED: 'cash collected', COD_REMITTED: 'cash remitted', NOT_COLLECTED: 'cash not collected',
};
/** "confirmed, packed, paid" for messages. */
export function describe(o: OrderState): string {
  return [o.status, o.fulfilmentStatus, o.paymentStatus].map((v) => WORDS[v] ?? v.toLowerCase()).join(', ');
}
