// POST /checkout/initiate (task 4.7; api.md §3.8, architecture.md §7.2–7.3, database.md §8.1).
//   TX1 (owner-fenced): re-priced order + items → aq_reserve_order → aq_reserve_coupon → history → attempt CREATING
//        (receipt AQA_<orderId>) → attach the order to the Idempotency-Key. COD: aq_place_cod_order in the same TX.
//   NET  Razorpay orders.create (never inside a transaction).
//   TX2  attempt CREATED + provider order id → 201 with the Razorpay details.
// Failure matrix: provider 4xx → attempt CREATION_FAILED, 201 {razorpay:null, retryPayment:true}; timeout/5xx → attempt
// PROVIDER_UNKNOWN, 202 PAYMENT_STARTING with the key kept open; a retry (same key) or the reconciler RESUMES the
// attached order: adopt the provider order found by our receipt, or create one with the same receipt once the lookup
// grace has passed. A new key for a cart that already has a pending order returns that order (200).
import { createHash, randomBytes } from 'node:crypto';
import { formatINR, type CheckoutInitiateInput, type InitiateResult, type checkoutInitiateBody } from '@artq/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { z } from 'zod';
import type { CartService } from '../cart/service.js';
import { DbFunctionError } from '../db/errors.js';
import * as fn from '../db/functions.js';
import type { IdempotencyContext, IdempotentResult } from '../idempotency/idempotency.js';
import { AppError } from '../lib/errors.js';
import { ProviderError, type PaymentProvider } from '../payments/razorpay.js';
import { applySnapshot } from '../payments/apply.js';
import { destinationFor } from '../shipping/destination.js';
import { mediaRef, setting, type MediaUrl } from '../storefront/home.js';

type Body = z.output<typeof checkoutInitiateBody>;
type Tx = Prisma.TransactionClient;
/** Runs a transaction: the idempotency owner's (fenced) one, or a plain one for the reconciler. */
type Run = <T>(work: (tx: Tx) => Promise<T>) => Promise<T>;

export type CheckoutDeps = {
  prisma: PrismaClient;
  carts: CartService;
  provider: PaymentProvider | null;
  mediaUrl: MediaUrl;
  storeName: string;
  /** How long a provider order may take to appear in the receipt lookup before we create one (task 4.0: ~20 s). */
  lookupGraceMs?: number;
};

export const RETRY_AFTER_S = 3;
const field = (path: string, message: string) => new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path, message }]);
const SHIPPING_REFUSAL: Record<string, [string, string]> = {
  UNKNOWN_PINCODE: ['PINCODE_NOT_SERVICEABLE', 'We couldn’t find this pincode. Please check the delivery address.'],
  NO_ZONE: ['PINCODE_NOT_SERVICEABLE', 'Sorry, we don’t deliver to this area yet.'],
  PINCODE_NOT_SERVICEABLE: ['PINCODE_NOT_SERVICEABLE', 'Sorry, we don’t deliver to this pincode yet.'],
  SHIPPING_RESTRICTED: ['SHIPPING_RESTRICTED', 'Some items (like resin) travel by road only and can’t be delivered to this pincode.'],
  DIMENSIONS_REQUIRED: ['SHIPPING_RESTRICTED', 'We can’t work out shipping for one of these items yet. Please contact us.'],
  NO_RATE: ['SHIPPING_RESTRICTED', 'This order is too heavy for our usual rates. Please contact us.'],
};

type AddressSnap = { fullName: string; phone: string; line1: string; line2: string | null; landmark: string | null; city: string; state: string; stateCode: string | null; stateId: number; pincode: string };

export class CheckoutService {
  constructor(private readonly d: CheckoutDeps) {}

  private get provider(): PaymentProvider {
    if (!this.d.provider) throw new AppError(422, 'PAYMENT_METHOD_UNAVAILABLE', 'Paying online isn’t available right now. Please choose cash on delivery.');
    return this.d.provider;
  }

  async initiate(ctx: IdempotencyContext, p: { cartId: number; userId: number | null; body: Body; ip: string | null; userAgent: string | null }): Promise<IdempotentResult> {
    const run: Run = (work) => ctx.tx(work);
    if (ctx.resume?.resourceType === 'order') return this.resume(run, ctx, ctx.resume.resourceId, 201);
    const pending = await this.d.prisma.order.findFirst({ where: { cartId: p.cartId, status: 'PENDING_PAYMENT' }, select: { orderNumber: true } });
    if (pending) return this.resume(run, ctx, pending.orderNumber, 200);
    const cart = await this.d.prisma.cart.findUnique({ where: { id: p.cartId }, select: { status: true } });
    if (cart?.status !== 'ACTIVE') throw new AppError(422, 'CART_EMPTY', 'Your cart is empty.');   // its order was placed
    const b = p.body;
    if (b.paymentMethod === 'RAZORPAY') void this.provider;   // refuse early when online payments are off

    const ship = await this.shippingAddress(p.userId, b);
    const bill = b.billingSameAsShipping ? null : await this.place(b.billingAddress!, 'billingAddress');
    // The guest's email now counts for the coupon's per-customer limit (account customers are matched by account).
    await this.d.prisma.cart.update({ where: { id: p.cartId }, data: { contactEmail: b.contact.email, contactPhone: b.contact.phone } });

    const q = await this.d.carts.priceForCheckout(p.cartId, ship.pincode, b.paymentMethod);
    this.refuse(q.view, q.blocking);
    if (q.view.totals.total !== b.expectedTotal) {
      throw new AppError(409, 'PRICE_CHANGED', `The total is now ${formatINR(q.view.totals.total)}. Please check your order and place it again.`, { total: q.view.totals.total, cart: q.view });
    }
    const quote = q.priced.shipping;
    if (!quote?.ok || !q.dest?.zone) throw new AppError(422, 'PINCODE_NOT_SERVICEABLE', 'Sorry, we don’t deliver to this pincode yet.');

    const order = await run(async (tx) => {
      const [seq] = await tx.$queryRaw<{ n: string }[]>`SELECT 'AQ' || nextval('order_number_seq') AS n`;
      const orderNumber = seq!.n;
      const lines = q.priced.lines.filter((l) => l.error === null);
      const created = await tx.order.create({
        data: {
          orderNumber, userId: p.userId, cartId: p.cartId, contactEmail: b.contact.email, contactPhone: b.contact.phone,
          paymentMethod: b.paymentMethod, subtotal: q.priced.subtotal, mrpTotal: q.priced.mrpTotal, couponDiscount: q.priced.couponDiscount,
          shippingFee: quote.shipping, codFee: q.priced.codFee, total: q.priced.total, taxTotal: lines.reduce((s, l) => s + (l.tax?.tax ?? 0), 0),
          couponId: q.coupon?.id ?? null, couponCode: q.coupon?.code ?? null,
          actualWeightG: quote.actualWeightG, chargeableWeightG: quote.chargeableWeightG, shippingZoneId: quote.zoneId,
          pricingSnapshot: JSON.parse(JSON.stringify({ ...q.priced, coupon: q.coupon ? { id: q.coupon.id, code: q.coupon.code, type: q.coupon.type, value: q.coupon.value, maxDiscount: q.coupon.maxDiscount, minOrderValue: q.coupon.minOrderValue, appliesTo: q.coupon.appliesTo } : null, zone: { id: q.dest!.zone!.id, name: q.dest!.zone!.name }, settings: q.settings, contact: { sendSetPasswordLink: p.userId === null && b.contact.sendSetPasswordLink } })) as Prisma.InputJsonValue,
          shipName: ship.fullName, shipPhone: ship.phone, shipLine1: ship.line1, shipLine2: ship.line2, shipLandmark: ship.landmark, shipCity: ship.city,
          shipState: ship.state, shipStateCode: ship.stateCode, shipPincode: ship.pincode,
          billSameAsShip: b.billingSameAsShipping, ...(bill ? { billingSnapshot: bill as unknown as Prisma.InputJsonValue } : {}), gstin: b.gstin, businessName: b.businessName,
          customerNote: b.customerNote, utmSource: b.utm?.source?.slice(0, 80) ?? null, utmMedium: b.utm?.medium?.slice(0, 80) ?? null, utmCampaign: b.utm?.campaign?.slice(0, 120) ?? null,
          ip: p.ip, userAgent: p.userAgent?.slice(0, 500) ?? null,
          trackingTokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
          expiresAt: new Date(Date.now() + q.pendingExpiryMinutes * 60_000),
          items: {
            create: lines.map((l) => {
              const r = q.rows.find((x) => x.variant_id === l.variantId)!;
              const img = mediaRef(q.media.find((m) => m.id === r.image_media_id), r.product_name, this.d.mediaUrl);
              return {
                productId: r.product_id, variantId: l.variantId, productName: r.product_name, variantLabel: r.label, sku: r.sku, imageUrl: img?.url ?? null,
                unitPrice: l.unitPrice!, unitMrp: l.unitMrp, quantity: l.quantity, lineTotal: l.lineTotal, discount: l.couponDiscount, netAmount: l.net,
                taxRate: Number(r.gst_rate), taxAmount: l.tax?.tax ?? 0, hsnCode: r.hsn_code, weightG: r.weight_g ?? 0,
              };
            }),
          },
        },
      });
      try {
        await fn.reserveOrder(tx, created.id);
        if (q.coupon) await fn.reserveCoupon(tx, { orderId: created.id, couponId: q.coupon.id, userId: p.userId, email: b.contact.email, phone: b.contact.phone, discount: q.priced.couponDiscount });
      } catch (e) { throw this.businessError(e); }
      await fn.history(tx, { orderId: created.id, dimension: 'ORDER', from: null, to: 'PENDING_PAYMENT', actor: 'CUSTOMER' });
      if (b.shippingAddress?.save && p.userId !== null) await this.saveAddress(tx, p.userId, ship, b.shippingAddress.label);
      await ctx.attach(tx, 'order', orderNumber);
      if (b.paymentMethod === 'COD') {
        await fn.placeCodOrder(tx, created.id, 'CUSTOMER');
        return { ...created, attempt: null };
      }
      const attempt = await tx.paymentAttempt.create({ data: { orderId: created.id, receipt: `AQA_${created.id}`, amount: created.total } });
      return { ...created, attempt };
    });

    if (order.paymentMethod === 'COD') return { status: 201, body: { orderNumber: order.orderNumber, status: 'PLACED', total: order.total } satisfies InitiateResult, resource: { type: 'order', id: order.orderNumber } };
    return this.startPayment(run, ctx, { ...order, attempt: order.attempt! }, 201);
  }

  // ── Provider order: create, adopt, or report ──

  private details(o: { orderNumber: string; total: number; expiresAt: Date | null; shipName: string; contactEmail: string; contactPhone: string }, providerOrderId: string): InitiateResult {
    return {
      orderNumber: o.orderNumber, status: 'PENDING_PAYMENT', total: o.total, expiresAt: (o.expiresAt ?? new Date()).toISOString(),
      razorpay: { keyId: this.provider.keyId, orderId: providerOrderId, amount: o.total, currency: 'INR', name: this.d.storeName, prefill: { name: o.shipName, email: o.contactEmail, contact: o.contactPhone } },
    };
  }

  private async startPayment(run: Run, ctx: Pick<IdempotencyContext, 'renew'> | null, o: OrderForPayment, status: 200 | 201): Promise<IdempotentResult> {
    await ctx?.renew();
    const resource = { type: 'order', id: o.orderNumber };
    try {
      const po = await this.provider.createOrder({ amount: o.attempt.amount, receipt: o.attempt.receipt, notes: { order: o.orderNumber } });
      return await this.adopt(run, o, po.id, status);
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      if (e.kind === 'DEFINITIVE') {
        await run((tx) => tx.paymentAttempt.updateMany({ where: { id: o.attempt.id, status: { in: ['CREATING', 'PROVIDER_UNKNOWN'] } }, data: { status: 'CREATION_FAILED', lastError: e.message.slice(0, 500) } }));
        return { status, body: { orderNumber: o.orderNumber, status: 'PENDING_PAYMENT', total: o.total, expiresAt: (o.expiresAt ?? new Date()).toISOString(), razorpay: null, retryPayment: true } satisfies InitiateResult, resource };
      }
      await run((tx) => tx.paymentAttempt.updateMany({ where: { id: o.attempt.id, status: 'CREATING' }, data: { status: 'PROVIDER_UNKNOWN', lastError: e.message.slice(0, 500) } }));
      return this.starting(o.orderNumber);
    }
  }

  private starting(orderNumber: string, retryAfter = RETRY_AFTER_S): IdempotentResult {
    return { status: 202, body: { orderNumber, status: 'PAYMENT_STARTING', retryAfter } satisfies InitiateResult, keepOpenSeconds: retryAfter };
  }

  /** TX2: the attempt gets its provider order (only from CREATING/PROVIDER_UNKNOWN: a CREATED attempt keeps its id). */
  private async adopt(run: Run, o: OrderForPayment, providerOrderId: string, status: 200 | 201): Promise<IdempotentResult> {
    const stored = await run(async (tx) => {
      await tx.paymentAttempt.updateMany({ where: { id: o.attempt.id, status: { in: ['CREATING', 'PROVIDER_UNKNOWN'] } }, data: { status: 'CREATED', providerOrderId, providerCheckedAt: new Date(), lastError: null } });
      return tx.paymentAttempt.findUniqueOrThrow({ where: { id: o.attempt.id } });
    });
    if (stored.status !== 'CREATED' || !stored.providerOrderId) return this.answerFor(o, stored, status);
    return { status, body: this.details(o, stored.providerOrderId), resource: { type: 'order', id: o.orderNumber } };
  }

  private answerFor(o: OrderForPayment, a: { status: string; providerOrderId: string | null }, status: 200 | 201): IdempotentResult {
    const resource = { type: 'order', id: o.orderNumber };
    if (a.status === 'CREATED' && a.providerOrderId) return { status, body: this.details(o, a.providerOrderId), resource };
    return { status, body: { orderNumber: o.orderNumber, status: 'PENDING_PAYMENT', total: o.total, expiresAt: (o.expiresAt ?? new Date()).toISOString(), razorpay: null, retryPayment: true } satisfies InitiateResult, resource };
  }

  /**
   * Continue an existing order (TAKEOVER of the same key, or a new key for a cart with a pending order): never a second
   * order. A pending order's open attempt is answered from its state; an unfinished one is recovered by receipt.
   */
  private async resume(run: Run, ctx: Pick<IdempotencyContext, 'renew'> | null, orderNumber: string, status: 200 | 201): Promise<IdempotentResult> {
    const o = await this.d.prisma.order.findUnique({ where: { orderNumber }, include: { paymentAttempts: { where: { status: { not: 'CLOSED' } }, orderBy: { id: 'desc' }, take: 1 } } });
    if (!o) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    const resource = { type: 'order', id: orderNumber };
    if (o.status === 'PLACED' || o.status === 'CONFIRMED' || o.status === 'COMPLETED') return { status, body: { orderNumber, status: 'PLACED', total: o.total } satisfies InitiateResult, resource };
    if (o.status !== 'PENDING_PAYMENT') throw new AppError(409, 'ORDER_EXPIRED', 'This order has expired. Please check out again.', { orderNumber });
    const attempt = o.paymentAttempts[0];
    if (!attempt) throw new AppError(409, 'ORDER_EXPIRED', 'This order can no longer be paid. Please check out again.', { orderNumber });
    const order: OrderForPayment = { ...o, attempt };
    if (attempt.status === 'CREATED' || attempt.status === 'CREATION_FAILED' || attempt.status === 'PAID') return this.answerFor(order, attempt, status);
    return this.recover(run, ctx, order, status);
  }

  /** CREATING / PROVIDER_UNKNOWN: adopt the provider order with our receipt; create one only after the lookup grace. */
  private async recover(run: Run, ctx: Pick<IdempotencyContext, 'renew'> | null, o: OrderForPayment, status: 200 | 201): Promise<IdempotentResult> {
    let found;
    try { found = await this.provider.findOrdersByReceipt(o.attempt.receipt); } catch (e) {
      if (e instanceof ProviderError) return this.starting(o.orderNumber);
      throw e;
    }
    if (found.length) return this.adopt(run, o, found[0]!.id, status);   // several (duplicate receipts): the earliest
    if (Date.now() - o.attempt.createdAt.getTime() < (this.d.lookupGraceMs ?? 120_000)) return this.starting(o.orderNumber, 5);
    return this.startPayment(run, ctx, o, status);
  }

  /**
   * POST /orders/:n/payment/retry (task 4.8, architecture.md §7.3): pay a pending order again, online or by switching to
   * cash on delivery. First any payment already made on its open attempts is applied (never take money twice); then,
   * in one fenced transaction, the open attempts are CLOSED and either a new attempt is created (receipt AQA_<id>_<n>,
   * the hold extended by up to 15 minutes, at most 60 minutes in all) or the order becomes COD (fee added) and placed.
   */
  async retryPayment(ctx: IdempotencyContext, orderNumber: string, method: 'RAZORPAY' | 'COD'): Promise<IdempotentResult> {
    const run: Run = (work) => ctx.tx(work);
    if (ctx.resume?.resourceType === 'order') return this.resume(run, ctx, ctx.resume.resourceId, 200);
    const o = await this.d.prisma.order.findUnique({ where: { orderNumber }, include: { paymentAttempts: { orderBy: { id: 'asc' } } } });
    if (!o) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    const placedAnswer = (): IdempotentResult => ({ status: 200, body: { orderNumber, status: 'PLACED', total: o.total } satisfies InitiateResult, resource: { type: 'order', id: orderNumber } });
    if (['PLACED', 'CONFIRMED', 'COMPLETED'].includes(o.status)) return placedAnswer();
    if (o.status !== 'PENDING_PAYMENT' || !o.expiresAt || o.expiresAt <= new Date()) throw new AppError(409, 'ORDER_EXPIRED', 'This order has expired. Please check out again.', { orderNumber });
    if (method === 'RAZORPAY') void this.provider;

    // Money first: a payment already made on an open attempt is applied, not paid again.
    if (this.d.provider) {
      for (const a of o.paymentAttempts.filter((x) => ['CREATED', 'CREATING', 'PROVIDER_UNKNOWN'].includes(x.status))) {
        try {
          const ids = a.providerOrderId ? [a.providerOrderId] : (await this.d.provider.findOrdersByReceipt(a.receipt)).map((x) => x.id);
          for (const id of ids) for (const p of await this.d.provider.orderPayments(id)) if (p.status !== 'created' && p.status !== 'failed') await applySnapshot(this.d.prisma, p, 'CUSTOMER');
        } catch (e) {
          if (e instanceof ProviderError) throw new AppError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'We couldn’t check your last payment just now. Please try again in a minute.');
          throw e;
        }
      }
    }
    const now = await this.d.prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    if (['PLACED', 'CONFIRMED', 'COMPLETED'].includes(now.status)) return placedAnswer();
    if (now.paymentStatus === 'PROCESSING') throw new AppError(409, 'PAYMENT_IN_PROGRESS', 'We’re still confirming your last payment. Please wait a moment.');

    const cod = method === 'COD' ? await this.codFor(now) : null;
    const next = await run(async (tx) => {
      const [locked] = await tx.$queryRaw<{ status: string; payment_status: string; expires_at: Date | null }[]>`SELECT status, payment_status, expires_at FROM orders WHERE id = ${o.id} FOR NO KEY UPDATE`;
      if (locked?.status !== 'PENDING_PAYMENT' || locked.payment_status !== 'UNPAID' || !locked.expires_at || locked.expires_at <= new Date()) throw new AppError(409, 'ORDER_EXPIRED', 'This order can no longer be paid. Please check out again.', { orderNumber });
      await tx.paymentAttempt.updateMany({ where: { orderId: o.id, status: { in: ['CREATING', 'CREATED', 'PROVIDER_UNKNOWN', 'CREATION_FAILED'] } }, data: { status: 'CLOSED' } });
      await ctx.attach(tx, 'order', orderNumber);
      if (cod) {
        await tx.order.update({ where: { id: o.id }, data: { paymentMethod: 'COD', codFee: cod.fee, total: now.total - now.codFee + cod.fee, version: { increment: 1 } } });
        await fn.placeCodOrder(tx, o.id, 'CUSTOMER');
        return null;
      }
      const n = await tx.paymentAttempt.count({ where: { orderId: o.id } });
      const limit = new Date(now.createdAt.getTime() + 60 * 60_000);
      const extended = new Date(Math.min(locked.expires_at.getTime() + 15 * 60_000, limit.getTime()));
      const order = await tx.order.update({ where: { id: o.id }, data: { expiresAt: extended > locked.expires_at ? extended : locked.expires_at } });
      const attempt = await tx.paymentAttempt.create({ data: { orderId: o.id, receipt: `AQA_${o.id}_${n + 1}`, amount: now.total } });
      return { ...order, attempt };
    });
    if (!next) return { status: 200, body: { orderNumber, status: 'PLACED', total: now.total - now.codFee + cod!.fee } satisfies InitiateResult, resource: { type: 'order', id: orderNumber } };
    return this.startPayment(run, ctx, next, 200);
  }

  /** Switching a pending online order to COD: allowed by the settings and the pincode, the new total within limits. */
  private async codFor(o: { shipPincode: string; total: number; codFee: number }): Promise<{ fee: number }> {
    const [d, pay] = await Promise.all([destinationFor(this.d.prisma, o.shipPincode), setting(this.d.prisma, 'PAYMENT')]);
    const total = o.total - o.codFee + pay.codFee;
    if (!pay.codEnabled || !d.serviceability.codAvailable || total < pay.codMin || total > pay.codMax) {
      throw new AppError(422, 'COD_NOT_AVAILABLE', 'Cash on delivery isn’t available for this order. Please pay online.');
    }
    return { fee: pay.codFee };
  }

  /** The reconciler's entry (AT-03, scheduled with task 4.9): resolve one unfinished attempt without a client. */
  async recoverAttempt(attemptId: number): Promise<'CREATED' | 'CREATION_FAILED' | 'WAITING' | 'UNCHANGED'> {
    const a = await this.d.prisma.paymentAttempt.findUnique({ where: { id: attemptId }, include: { order: true } });
    if (!a || !['CREATING', 'PROVIDER_UNKNOWN'].includes(a.status) || a.order.status !== 'PENDING_PAYMENT') return 'UNCHANGED';
    const run: Run = (work) => this.d.prisma.$transaction(work);
    const r = await this.recover(run, null, { ...a.order, attempt: a }, 200);
    if (r.status === 202) return 'WAITING';
    const after = await this.d.prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    return after.status === 'CREATED' ? 'CREATED' : after.status === 'CREATION_FAILED' ? 'CREATION_FAILED' : 'UNCHANGED';
  }

  // ── Checks ──

  private refuse(view: { items: unknown[] }, blocking: string[]) {
    if (view.items.length === 0 || blocking.includes('CART_EMPTY')) throw new AppError(422, 'CART_EMPTY', 'Your cart is empty.');
    const stock = blocking.filter((b) => b.startsWith('UNAVAILABLE') || b.startsWith('INSUFFICIENT_STOCK'));
    if (stock.length) throw new AppError(409, 'OUT_OF_STOCK', 'Some items are no longer available in that quantity. Please review your cart.', { lines: stock });
    for (const b of blocking) {
      const s = SHIPPING_REFUSAL[b];
      if (s) throw new AppError(422, s[0], s[1]);
    }
    if (blocking.includes('COD_NOT_AVAILABLE')) throw new AppError(422, 'COD_NOT_AVAILABLE', 'Cash on delivery isn’t available for this order. Please pay online.');
    if (blocking.includes('ONLINE_DISABLED')) throw new AppError(422, 'PAYMENT_METHOD_UNAVAILABLE', 'Paying online isn’t available right now. Please choose cash on delivery.');
    if (blocking.includes('DESTINATION_REQUIRED')) throw field('shippingAddress', 'Choose or add a delivery address');
  }

  private businessError(e: unknown): unknown {
    if (!(e instanceof DbFunctionError)) return e;
    if (e.code === 'OUT_OF_STOCK') return new AppError(409, 'OUT_OF_STOCK', 'Some items are no longer available in that quantity. Please review your cart.', { lines: [`INSUFFICIENT_STOCK:${e.detail ?? ''}`] });
    if (e.code === 'COUPON_USAGE_EXCEEDED') return new AppError(422, 'COUPON_USAGE_EXCEEDED', e.detail === 'customer' ? 'You have already used this coupon. Remove it to continue.' : 'This coupon has just been fully used. Remove it to continue.');
    if (e.code === 'COUPON_INVALID') return new AppError(422, 'COUPON_INVALID', 'This coupon is no longer valid. Remove it to continue.');
    return e;
  }

  private async shippingAddress(userId: number | null, b: Body): Promise<AddressSnap> {
    if (b.shippingAddressId !== null) {
      const a = userId === null ? null : await this.d.prisma.address.findFirst({ where: { id: b.shippingAddressId, userId }, include: { state: true } });
      if (!a) throw field('shippingAddressId', 'Choose a delivery address');
      return { fullName: a.fullName, phone: a.phone, line1: a.line1, line2: a.line2, landmark: a.landmark, city: a.city, state: a.state.name, stateCode: a.state.gstCode, stateId: a.stateId, pincode: a.pincode };
    }
    return this.place(b.shippingAddress!, 'shippingAddress');
  }

  /** A typed address: an active state, and a pincode the postal directory places in that state. */
  private async place(a: NonNullable<CheckoutInitiateInput['billingAddress']> & { stateId: number }, prefix: 'shippingAddress' | 'billingAddress'): Promise<AddressSnap> {
    const state = await this.d.prisma.state.findFirst({ where: { id: a.stateId, isActive: true } });
    if (!state) throw field(`${prefix}.stateId`, 'Choose a state');
    const office = await this.d.prisma.postalCode.findFirst({ where: { pincode: a.pincode }, include: { state: true } });
    if (office && office.stateId !== state.id) throw field(`${prefix}.pincode`, `This pincode is in ${office.state.name}`);
    return { fullName: a.fullName, phone: a.phone, line1: a.line1, line2: a.line2 ?? null, landmark: a.landmark ?? null, city: a.city, state: state.name, stateCode: state.gstCode, stateId: state.id, pincode: a.pincode };
  }

  private async saveAddress(tx: Tx, userId: number, s: AddressSnap, label: 'HOME' | 'WORK' | 'OTHER') {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR NO KEY UPDATE`;
    const count = await tx.address.count({ where: { userId } });
    if (count >= 10) return;   // the address book is full: the order still has its own copy
    const state = await tx.state.findUniqueOrThrow({ where: { id: s.stateId } });
    await tx.address.create({ data: { userId, label, fullName: s.fullName, phone: s.phone, line1: s.line1, line2: s.line2, landmark: s.landmark, city: s.city, stateId: s.stateId, countryId: state.countryId, pincode: s.pincode, isDefault: count === 0 } });
  }
}

type OrderForPayment = {
  orderNumber: string; total: number; expiresAt: Date | null; shipName: string; contactEmail: string; contactPhone: string;
  attempt: { id: number; receipt: string; amount: number; createdAt: Date };
};
