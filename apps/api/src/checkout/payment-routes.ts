// After the Razorpay window (task 4.8; api.md §3.8, architecture.md §7.1–7.3):
//   POST /checkout/verify          signature against the STORED provider order id (the browser's order id is ignored),
//                                  then the payment fetched from Razorpay → aq_apply_provider_payment (fetchAndApply)
//   GET  /checkout/status/:n       polled while PROCESSING
//   POST /checkout/payment-failed  informational only
//   POST /orders/:n/payment/retry  Idempotency-Key (op payment.retry): pay again online, or switch to COD
// An order is reachable by the cart cookie that created it or by its owner's Bearer; anyone else gets 404.
import { paymentRetryBody, type CheckoutStatus, type VerifyResult } from '@artq/shared';
import type { Order } from '@prisma/client';
import { Router, type Request, type Response } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';
import { cookieSpec, parseCookies, type DeployEnv } from '../auth/cookies.js';
import { optionalCustomer, type AuthDeps } from '../auth/middleware.js';
import { hashToken } from '../cart/service.js';
import { idempotent } from '../idempotency/idempotency.js';
import { AppError } from '../lib/errors.js';
import { RATE_LIMITS, rateLimit, type RateLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { fetchAndApply } from '../payments/apply.js';
import { ProviderError, type PaymentProvider } from '../payments/razorpay.js';
import type { CheckoutService } from './initiate.js';

const orderParam = z.strictObject({ orderNumber: z.string().regex(/^AQ\d{1,15}$/, 'Not an order number') });
const verifyBody = z.strictObject({
  orderNumber: z.string().regex(/^AQ\d{1,15}$/),
  razorpayPaymentId: z.string().regex(/^pay_[A-Za-z0-9]{1,40}$/, 'Not a Razorpay payment id'),
  razorpaySignature: z.string().regex(/^[0-9a-f]{64}$/i, 'Not a Razorpay signature'),
});
const failedBody = z.strictObject({
  orderNumber: z.string().regex(/^AQ\d{1,15}$/),
  razorpayPaymentId: z.string().max(60).nullable().optional(),
  error: z.string().max(500),
});

/** What the customer is told (product.md §8.5 customer view). */
export function displayStatus(o: Pick<Order, 'status' | 'paymentStatus'>): string {
  if (o.status === 'PENDING_PAYMENT') return o.paymentStatus === 'PROCESSING' ? 'Payment processing' : 'Awaiting payment';
  if (o.status === 'EXPIRED') return 'Payment not completed';
  if (o.status === 'CANCELLED') return 'Cancelled';
  return 'Order placed';
}

export type PaymentRoutesDeps = AuthDeps & {
  env: DeployEnv; checkout: CheckoutService; provider: PaymentProvider | null; log: Logger;
  limiter?: RateLimiter; onRateLimitError?: (e: unknown) => void; lockSeconds?: number;
};

export function checkoutPaymentRouter(d: PaymentRoutesDeps): Router {
  const r = Router();
  r.use(['/checkout', '/orders'], optionalCustomer(d));
  const spec = cookieSpec('cart', d.env);
  const cartToken = (req: Request) => parseCookies(req.get('cookie')).get(spec.name);
  const limit = d.limiter ? rateLimit({ limiter: d.limiter, name: 'checkout', rule: RATE_LIMITS.checkout, key: async (req) => (req.auth ? `u:${req.auth.userId}` : cartToken(req) ? `c:${hashToken(cartToken(req)!)}` : null), ...(d.onRateLimitError ? { onError: d.onRateLimitError } : {}) }) : (_q: Request, _s: Response, n: () => void) => n();

  /** The order, if this browser (cart cookie) or this account placed it; else 404 (never reveals that it exists). */
  const orderFor = async (req: Request, orderNumber: string) => {
    const o = await d.prisma.order.findUnique({ where: { orderNumber }, include: { paymentAttempts: { where: { providerOrderId: { not: null } }, orderBy: { id: 'desc' } } } });
    const t = cartToken(req);
    const byCart = o?.cartId && t ? (await d.prisma.cart.findFirst({ where: { id: o.cartId, tokenHash: hashToken(t) }, select: { id: true } })) !== null : false;
    const byAccount = o?.userId !== null && o?.userId !== undefined && req.auth?.userId === o.userId;
    if (!o || !(byCart || byAccount)) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    return o;
  };
  const noStore = (res: Response) => res.set('Cache-Control', 'no-store');

  r.post('/checkout/verify', limit, validate({ body: verifyBody }), async (req, res) => {
    const b = req.body as z.output<typeof verifyBody>;
    const o = await orderFor(req, b.orderNumber);
    if (!d.provider) throw new AppError(422, 'PAYMENT_METHOD_UNAVAILABLE', 'Paying online isn’t available right now.');
    // The signature is checked against the provider order ids WE stored for this order, never one sent by the browser.
    const attempt = o.paymentAttempts.find((a) => d.provider!.verifySignature(a.providerOrderId!, b.razorpayPaymentId, b.razorpaySignature));
    if (!attempt) {
      await d.prisma.auditLog.create({ data: { actorId: req.auth?.userId ?? null, action: 'checkout.verify_failed', entity: 'order', entityId: o.orderNumber, after: { paymentId: b.razorpayPaymentId }, ip: req.ip ?? null, userAgent: req.get('user-agent')?.slice(0, 500) ?? null } });
      throw new AppError(422, 'PAYMENT_VERIFICATION_FAILED', 'We couldn’t verify this payment. If money was taken, it will be confirmed or refunded automatically.');
    }
    let outcome: string | null;
    try { outcome = (await fetchAndApply(d.prisma, d.provider, b.razorpayPaymentId, 'CUSTOMER')).outcome; } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      d.log.warn({ order: o.orderNumber, err: e.message }, 'verify: provider unreachable, the webhook/reconciler will apply the payment');
      noStore(res).status(202).json({ status: 'PROCESSING' } satisfies VerifyResult);
      return;
    }
    const after = await d.prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    const pay = await d.prisma.payment.findUnique({ where: { providerPaymentId: b.razorpayPaymentId }, select: { allocation: true } });
    const status: VerifyResult['status'] =
      ['PLACED', 'CONFIRMED', 'COMPLETED'].includes(after.status) && (outcome === 'APPLIED' || pay?.allocation === 'APPLIED' || pay?.allocation === 'EXCESS') ? 'PLACED'
        : pay?.allocation === 'VOID' || pay?.allocation === 'LATE' ? 'PAYMENT_REFUNDED'
          : pay?.allocation === 'HELD' || outcome === 'CONFLICT' || outcome === 'HELD' ? 'REVIEW'
            : 'PROCESSING';
    noStore(res).status(status === 'PROCESSING' ? 202 : 200).json({ status } satisfies VerifyResult);
  });

  r.get('/checkout/status/:orderNumber', validate({ params: orderParam }), async (req, res) => {
    const o = await orderFor(req, (req.params as { orderNumber: string }).orderNumber);
    noStore(res).json({ status: o.status, paymentStatus: o.paymentStatus, displayStatus: displayStatus(o) } satisfies CheckoutStatus);
  });

  r.post('/checkout/payment-failed', limit, validate({ body: failedBody }), async (req, res) => {
    const b = req.body as z.output<typeof failedBody>;
    const o = await orderFor(req, b.orderNumber);
    d.log.info({ order: o.orderNumber, paymentId: b.razorpayPaymentId ?? null, error: b.error }, 'checkout: payment failed or closed in the browser');
    noStore(res).json({ ok: true });
  });

  const orderOf = (req: Request) => (req.res!.locals as { orderNumber: string }).orderNumber;
  r.post('/orders/:orderNumber/payment/retry', limit, validate({ params: orderParam, body: paymentRetryBody }), async (req, res, next) => {
    const o = await orderFor(req, (req.params as { orderNumber: string }).orderNumber);
    res.locals.orderNumber = o.orderNumber;
    res.locals.scope = req.auth ? `user:${req.auth.userId}` : `order:${o.orderNumber}`;
    next();
  }, idempotent({ prisma: d.prisma, log: d.log }, {
    operation: 'payment.retry',
    scope: (req) => (req.res!.locals as { scope: string }).scope,
    target: (req) => `order:${orderOf(req)}`,
    ...(d.lockSeconds === undefined ? {} : { lockSeconds: d.lockSeconds }),
  }, (req, ctx) => d.checkout.retryPayment(ctx, orderOf(req), (req.body as z.output<typeof paymentRetryBody>).paymentMethod)));

  return r;
}
