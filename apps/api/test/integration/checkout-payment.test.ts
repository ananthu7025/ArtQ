// Task 4.8: after the Razorpay window, on real PostgreSQL with a stub Razorpay. Verify (signature against the STORED
// provider order, payment fetched from the provider, one apply), status polling, payment-failed, and payment retry
// (online again, or switch to COD), with order access limited to the cart that placed it or the owner.
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { cookieSpec } from '../../src/auth/cookies.js';
import { cartRouter } from '../../src/cart/routes.js';
import { CartService } from '../../src/cart/service.js';
import { CheckoutService } from '../../src/checkout/initiate.js';
import { checkoutPaymentRouter } from '../../src/checkout/payment-routes.js';
import { FakeRazorpay, type PaymentProvider } from '../../src/payments/razorpay.js';
import { seedGeo, seedSettings, seedShipping } from '../../src/seed/steps.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { uniq } from '../helpers/fixtures.js';
import { startPostgres, type Service } from '../helpers/services.js';
import { liveProduct, type LiveProduct } from '../helpers/storefront-fixtures.js';

const WEB = 'http://localhost:3000';
const CART = cookieSpec('cart', 'test').name;
const mediaUrl = (k: string) => `https://cdn.test/${k}`;
let pg: Service, db: TestDb, prisma: PrismaClient, app: Express, kerala: number;
let fake: FakeRazorpay;
const provider: PaymentProvider = {
  keyId: 'rzp_test_fake',
  createOrder: (o) => fake.createOrder(o), findOrdersByReceipt: (r) => fake.findOrdersByReceipt(r), fetchPayment: (id) => fake.fetchPayment(id),
  orderPayments: (id) => fake.orderPayments(id), verifySignature: (o, p, s) => fake.verifySignature(o, p, s),
};

beforeAll(async () => {
  pg = await startPostgres();
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  await seedShipping(prisma); await seedGeo(prisma); await seedSettings(prisma);
  kerala = (await prisma.state.findFirstOrThrow({ where: { name: 'Kerala' } })).id;
  await prisma.postalCode.create({ data: { pincode: '682011', officeName: 'ERNAKULAM H.O', district: 'ERNAKULAM', stateId: kerala } });
  const log = pino({ level: 'silent' });
  const checkout = new CheckoutService({ prisma, carts: new CartService(prisma, mediaUrl), provider, mediaUrl, storeName: 'ArtQ' });
  app = createApp({ version: 't', origins: { storefront: [WEB], admin: ['http://localhost:5173'] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [cartRouter({ prisma, env: 'test', mediaUrl, checkout: { provider, storeName: 'ArtQ', log, lockSeconds: 1 } }), checkoutPaymentRouter({ prisma, env: 'test', provider, log, checkout, lockSeconds: 1 } as Parameters<typeof checkoutPaymentRouter>[0])] } as Parameters<typeof createApp>[0]);
}, 180_000);
afterAll(async () => { await db?.drop(); await pg?.stop(); });
beforeEach(() => { fake = new FakeRazorpay(); });

/** A guest who placed an online order (Razorpay window open). */
async function pending(o: { price?: number; fail?: boolean } = {}) {
  const p: LiveProduct = await liveProduct(prisma, { variants: [{ price: o.price ?? 120_000, onHand: 10 }] });
  const add = await request(app).post('/v1/cart/items').set('Origin', WEB).send({ variantId: p.variantIds[0] });
  const cookie = `${CART}=${String(([] as string[]).concat(add.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${CART}=`))).slice(CART.length + 1).split(';')[0]}`;
  const total = (await request(app).post('/v1/checkout/quote').set('Origin', WEB).set('Cookie', cookie).send({ pincode: '682011' })).body.cart.totals.total as number;
  if (o.fail) fake.next = ['definitive'];
  const res = await request(app).post('/v1/checkout/initiate').set('Origin', WEB).set('Cookie', cookie).set('Idempotency-Key', randomUUID()).send({
    contact: { email: `p${uniq()}@example.com`, phone: '9847012345' }, shippingAddress: { fullName: 'Hema R', phone: '9847012345', line1: '12 Rose Villa', city: 'Kochi', stateId: kerala, pincode: '682011' },
    paymentMethod: 'RAZORPAY', expectedTotal: total, acceptTerms: true,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const call = (method: 'get' | 'post', path: string, body?: object, key?: string) => {
    let r = request(app)[method](`/v1${path}`).set('Origin', WEB).set('Cookie', cookie);
    if (key) r = r.set('Idempotency-Key', key);
    return body ? r.send(body) : r;
  };
  const orderNumber = res.body.orderNumber as string;
  return { p, cookie, orderNumber, providerOrderId: res.body.razorpay?.orderId as string | undefined, total, call,
    verify: (paymentId: string, sig?: string) => call('post', '/checkout/verify', { orderNumber, razorpayPaymentId: paymentId, razorpaySignature: sig ?? fake.sign(res.body.razorpay.orderId, paymentId) }) };
}
const order = (n: string) => prisma.order.findUniqueOrThrow({ where: { orderNumber: n }, include: { paymentAttempts: { orderBy: { id: 'asc' } }, payments: true } });

describe('verify', () => {
  it('a captured payment places the order once (verify again: still PLACED, nothing twice)', async () => {
    const g = await pending();
    const pay = fake.pay(g.providerOrderId!);
    const res = await g.verify(pay.id);
    expect([res.status, res.body]).toEqual([200, { status: 'PLACED' }]);
    const o = await order(g.orderNumber);
    expect(o).toMatchObject({ status: 'PLACED', paymentStatus: 'PAID', capturedAmount: g.total, expiresAt: null });
    expect(o.paymentAttempts[0]!.status).toBe('PAID');
    expect(o.payments).toEqual([expect.objectContaining({ providerPaymentId: pay.id, allocation: 'APPLIED' })]);
    expect(await prisma.cart.findFirstOrThrow({ where: { id: o.cartId! } })).toMatchObject({ status: 'CONVERTED' });
    expect([(await g.verify(pay.id)).body, (await g.verify(pay.id)).status]).toEqual([{ status: 'PLACED' }, 200]);
    expect(await prisma.outboxEvent.count({ where: { eventType: 'order.placed', aggregateId: g.orderNumber } })).toBe(1);
  });

  it('a wrong signature, or one made for another order\'s Razorpay order → 422 (audited); nothing changes', async () => {
    const g = await pending();
    const other = await pending();
    const pay = fake.pay(g.providerOrderId!);
    expect((await g.verify(pay.id, 'a'.repeat(64))).body.error.code).toBe('PAYMENT_VERIFICATION_FAILED');
    expect((await g.verify(pay.id, fake.sign(other.providerOrderId!, pay.id))).body.error.code).toBe('PAYMENT_VERIFICATION_FAILED');
    expect(await prisma.auditLog.count({ where: { action: 'checkout.verify_failed', entityId: g.orderNumber } })).toBe(2);
    expect((await order(g.orderNumber)).status).toBe('PENDING_PAYMENT');
    expect((await g.call('post', '/checkout/verify', { orderNumber: g.orderNumber, razorpayPaymentId: pay.id, razorpaySignature: 'nope' })).status).toBe(400);
  });

  it('authorized only → 202 PROCESSING (order PROCESSING); Razorpay unreachable → 202 and the order is untouched', async () => {
    const g = await pending();
    const auth = fake.pay(g.providerOrderId!, { status: 'authorized' });
    const res = await g.verify(auth.id);
    expect([res.status, res.body]).toEqual([202, { status: 'PROCESSING' }]);
    expect(await order(g.orderNumber)).toMatchObject({ status: 'PENDING_PAYMENT', paymentStatus: 'PROCESSING' });
    expect((await g.call('get', `/checkout/status/${g.orderNumber}`)).body).toEqual({ status: 'PENDING_PAYMENT', paymentStatus: 'PROCESSING', displayStatus: 'Payment processing' });
    const h = await pending();
    const pay = fake.pay(h.providerOrderId!);
    fake.fetchFails = true;
    expect([(await h.verify(pay.id)).status]).toEqual([202]);
    expect(await order(h.orderNumber)).toMatchObject({ status: 'PENDING_PAYMENT', paymentStatus: 'UNPAID', payments: [] });
  });

  it('wrong amount → REVIEW (held for staff); refunded before we saw it → PAYMENT_REFUNDED (not placed)', async () => {
    const g = await pending();
    const short = fake.pay(g.providerOrderId!, { amount: g.total - 100 });
    expect((await g.verify(short.id)).body).toEqual({ status: 'REVIEW' });
    expect(await prisma.paymentException.count({ where: { orderId: (await order(g.orderNumber)).id, type: 'AMOUNT_MISMATCH' } })).toBe(1);
    const h = await pending();
    const refunded = fake.pay(h.providerOrderId!, { status: 'refunded', amountRefunded: h.total });
    expect((await h.verify(refunded.id)).body).toEqual({ status: 'PAYMENT_REFUNDED' });
    expect((await order(h.orderNumber)).status).toBe('PENDING_PAYMENT');
  });
});

describe('status, payment-failed, access', () => {
  it('only the cart that placed the order (or its owner) can see it; others and unknown orders → 404; bad numbers → 400', async () => {
    const g = await pending();
    expect((await g.call('get', `/checkout/status/${g.orderNumber}`)).body).toEqual({ status: 'PENDING_PAYMENT', paymentStatus: 'UNPAID', displayStatus: 'Awaiting payment' });
    expect((await request(app).get(`/v1/checkout/status/${g.orderNumber}`)).status).toBe(404);
    const stranger = await pending();
    expect((await stranger.call('get', `/checkout/status/${g.orderNumber}`)).status).toBe(404);
    expect((await g.call('get', '/checkout/status/AQ999999')).status).toBe(404);
    expect((await g.call('get', '/checkout/status/1234')).status).toBe(400);
    expect((await stranger.call('post', `/orders/${g.orderNumber}/payment/retry`, { paymentMethod: 'RAZORPAY' }, randomUUID())).status).toBe(404);
  });
  it('payment-failed is recorded in the log only: the order does not change', async () => {
    const g = await pending();
    expect((await g.call('post', '/checkout/payment-failed', { orderNumber: g.orderNumber, razorpayPaymentId: 'pay_x', error: 'Card declined' })).body).toEqual({ ok: true });
    expect(await order(g.orderNumber)).toMatchObject({ status: 'PENDING_PAYMENT', paymentStatus: 'UNPAID' });
  });
});

describe('payment retry', () => {
  it('online again: the old attempt is CLOSED, a new one AQA_<id>_2 is created; the hold is extended by up to 15 minutes', async () => {
    const g = await pending({ fail: true });
    const before = await order(g.orderNumber);
    const key = randomUUID();
    const res = await g.call('post', `/orders/${g.orderNumber}/payment/retry`, { paymentMethod: 'RAZORPAY' }, key);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ orderNumber: g.orderNumber, status: 'PENDING_PAYMENT', razorpay: { orderId: fake.orders[0]!.id } });
    const after = await order(g.orderNumber);
    expect(after.paymentAttempts.map((a) => [a.receipt, a.status])).toEqual([[`AQA_${after.id}`, 'CLOSED'], [`AQA_${after.id}_2`, 'CREATED']]);
    const extendedBy = after.expiresAt!.getTime() - before.expiresAt!.getTime();
    expect(extendedBy).toBeGreaterThan(14 * 60_000);
    expect(extendedBy).toBeLessThanOrEqual(15 * 60_000);
    const replay = await g.call('post', `/orders/${g.orderNumber}/payment/retry`, { paymentMethod: 'RAZORPAY' }, key);
    expect([replay.status, replay.headers['idempotent-replayed'], replay.body]).toEqual([200, 'true', res.body]);
    expect((await g.call('post', `/orders/${g.orderNumber}/payment/retry`, { paymentMethod: 'RAZORPAY' })).status).toBe(400);   // key required
    const pay = fake.pay(fake.orders[0]!.id);
    expect((await g.call('post', '/checkout/verify', { orderNumber: g.orderNumber, razorpayPaymentId: pay.id, razorpaySignature: fake.sign(fake.orders[0]!.id, pay.id) })).body).toEqual({ status: 'PLACED' });
  });

  it('never more than 60 minutes in all', async () => {
    const g = await pending({ fail: true });
    const o = await order(g.orderNumber);
    await prisma.order.update({ where: { id: o.id }, data: { createdAt: new Date(Date.now() - 50 * 60_000), expiresAt: new Date(Date.now() + 5 * 60_000) } });
    await g.call('post', `/orders/${g.orderNumber}/payment/retry`, { paymentMethod: 'RAZORPAY' }, randomUUID());
    expect(Math.round(((await order(g.orderNumber)).expiresAt!.getTime() - Date.now()) / 60_000)).toBe(10);   // created 50 min ago → 60 min
  });

  it('a payment already made on the old attempt is applied, not taken again → PLACED, no new Razorpay order', async () => {
    const g = await pending();
    fake.pay(g.providerOrderId!);   // paid, but the browser never verified
    const res = await g.call('post', `/orders/${g.orderNumber}/payment/retry`, { paymentMethod: 'RAZORPAY' }, randomUUID());
    expect(res.body).toEqual({ orderNumber: g.orderNumber, status: 'PLACED', total: g.total });
    expect([fake.createCalls, (await order(g.orderNumber)).paymentStatus]).toEqual([1, 'PAID']);
  });

  it('an authorization in progress → 409 PAYMENT_IN_PROGRESS', async () => {
    const g = await pending();
    fake.pay(g.providerOrderId!, { status: 'authorized' });
    expect((await g.call('post', `/orders/${g.orderNumber}/payment/retry`, { paymentMethod: 'COD' }, randomUUID())).body.error.code).toBe('PAYMENT_IN_PROGRESS');
  });

  it('switch to COD: fee added, PLACED + COD_PENDING; refused when the pincode has no COD; an expired order → 409', async () => {
    const g = await pending({ price: 49_900 });
    const res = await g.call('post', `/orders/${g.orderNumber}/payment/retry`, { paymentMethod: 'COD' }, randomUUID());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ orderNumber: g.orderNumber, status: 'PLACED', total: g.total + 4000 });
    expect(await order(g.orderNumber)).toMatchObject({ status: 'PLACED', paymentStatus: 'COD_PENDING', paymentMethod: 'COD', codFee: 4000, total: g.total + 4000 });
    expect((await order(g.orderNumber)).paymentAttempts.every((a) => a.status === 'CLOSED')).toBe(true);

    const h = await pending({ price: 49_900 });
    await prisma.pincodeServiceability.create({ data: { pincode: '682011', isServiceable: true, codAvailable: false } });
    expect((await h.call('post', `/orders/${h.orderNumber}/payment/retry`, { paymentMethod: 'COD' }, randomUUID())).body.error.code).toBe('COD_NOT_AVAILABLE');
    await prisma.pincodeServiceability.delete({ where: { pincode: '682011' } });
    await prisma.order.update({ where: { orderNumber: h.orderNumber }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await h.call('post', `/orders/${h.orderNumber}/payment/retry`, { paymentMethod: 'RAZORPAY' }, randomUUID())).body.error.code).toBe('ORDER_EXPIRED');
  });
});
