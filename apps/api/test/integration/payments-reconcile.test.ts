// Task 4.9: Razorpay webhooks on the inbox, the payment jobs and the late/excess capture paths, on real PostgreSQL with
// a stub Razorpay. AT-04 (crash after durable receipt), AT-05 (verify + webhook + reconciler on one capture), AT-06 (two
// captures for one order), AT-07 (capture racing expiry and cancellation), plus UNLINKED recovery, stale
// authorizations, a voided authorization, the expiry pre-check, the daily reconciliation and refund webhooks.
import { createHmac, randomUUID } from 'node:crypto';
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
import * as fn from '../../src/db/functions.js';
import { applySnapshot } from '../../src/payments/apply.js';
import { FakeRazorpay, type PaymentProvider } from '../../src/payments/razorpay.js';
import { expirePending, reconcileAttempts, reconcileDaily } from '../../src/payments/reconcile.js';
import { razorpayHandlers } from '../../src/payments/webhook-handlers.js';
import { seedGeo, seedSettings, seedShipping } from '../../src/seed/steps.js';
import { processWebhook, sweepWebhooks, webhookRouter } from '../../src/webhooks/inbox.js';
import { razorpayProvider } from '../../src/webhooks/provider.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { uniq } from '../helpers/fixtures.js';
import { startPostgres, type Service } from '../helpers/services.js';
import { liveProduct, type LiveProduct } from '../helpers/storefront-fixtures.js';

const WEB = 'http://localhost:3000';
const SECRET = 'whsec-test-0123456789';
const CART = cookieSpec('cart', 'test').name;
const mediaUrl = (k: string) => `https://cdn.test/${k}`;
const log = pino({ level: 'silent' });
let pg: Service, db: TestDb, prisma: PrismaClient, app: Express, kerala: number;
let fake: FakeRazorpay;
/** Always the current test's fake. */
const provider = new Proxy({} as PaymentProvider, { get: (_t, k) => { const v = (fake as unknown as Record<string | symbol, unknown>)[k]; return typeof v === 'function' ? v.bind(fake) : v; } });
const queued: number[] = [];
let checkout: CheckoutService;
const providers = () => [razorpayProvider(SECRET, razorpayHandlers(provider))];
const deps = () => ({ prisma, provider, checkout, log });

beforeAll(async () => {
  pg = await startPostgres();
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  await seedShipping(prisma); await seedGeo(prisma); await seedSettings(prisma);
  kerala = (await prisma.state.findFirstOrThrow({ where: { name: 'Kerala' } })).id;
  await prisma.postalCode.create({ data: { pincode: '682011', officeName: 'ERNAKULAM H.O', district: 'ERNAKULAM', stateId: kerala } });
  checkout = new CheckoutService({ prisma, carts: new CartService(prisma, mediaUrl), provider, mediaUrl, storeName: 'ArtQ' });
  app = createApp({ version: 't', origins: { storefront: [WEB], admin: ['http://localhost:5173'] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [
      cartRouter({ prisma, env: 'test', mediaUrl, checkout: { provider, storeName: 'ArtQ', log, lockSeconds: 1 } }),
      checkoutPaymentRouter({ prisma, env: 'test', provider, log, checkout } as Parameters<typeof checkoutPaymentRouter>[0]),
      webhookRouter({ prisma, queue: { add: async (_n: string, data: { id: number }) => { queued.push(data.id); return undefined as never; } }, providers: providers(), log }),
    ] } as Parameters<typeof createApp>[0]);
}, 180_000);
afterAll(async () => { await db?.drop(); await pg?.stop(); });
beforeEach(() => { fake = new FakeRazorpay(); queued.length = 0; });

async function pending(o: { price?: number; onHand?: number; product?: LiveProduct; couponCode?: string } = {}) {
  const p = o.product ?? await liveProduct(prisma, { variants: [{ price: o.price ?? 120_000, onHand: o.onHand ?? 10 }] });
  const add = await request(app).post('/v1/cart/items').set('Origin', WEB).send({ variantId: p.variantIds[0] });
  const cookie = `${CART}=${String(([] as string[]).concat(add.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${CART}=`))).slice(CART.length + 1).split(';')[0]}`;
  if (o.couponCode) expect((await request(app).post('/v1/cart/coupon').set('Origin', WEB).set('Cookie', cookie).send({ code: o.couponCode })).status).toBe(200);
  const total = (await request(app).post('/v1/checkout/quote').set('Origin', WEB).set('Cookie', cookie).send({ pincode: '682011' })).body.cart.totals.total as number;
  const res = await request(app).post('/v1/checkout/initiate').set('Origin', WEB).set('Cookie', cookie).set('Idempotency-Key', randomUUID()).send({
    contact: { email: `r${uniq()}@example.com`, phone: '9847012345' }, shippingAddress: { fullName: 'Hema R', phone: '9847012345', line1: '12 Rose Villa', city: 'Kochi', stateId: kerala, pincode: '682011' },
    paymentMethod: 'RAZORPAY', expectedTotal: total, acceptTerms: true,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const orderNumber = res.body.orderNumber as string;
  return {
    p, cookie, orderNumber, total, providerOrderId: res.body.razorpay?.orderId as string,
    verify: (paymentId: string) => request(app).post('/v1/checkout/verify').set('Origin', WEB).set('Cookie', cookie).send({ orderNumber, razorpayPaymentId: paymentId, razorpaySignature: fake.sign(res.body.razorpay.orderId, paymentId) }),
    retry: (method: 'RAZORPAY' | 'COD') => request(app).post(`/v1/orders/${orderNumber}/payment/retry`).set('Origin', WEB).set('Cookie', cookie).set('Idempotency-Key', randomUUID()).send({ paymentMethod: method }),
  };
}
const order = (n: string) => prisma.order.findUniqueOrThrow({ where: { orderNumber: n }, include: { payments: true, paymentAttempts: { orderBy: { id: 'asc' } }, refunds: true, exceptions: true } });
/** Razorpay delivers a signed webhook; returns the inbox row id. */
async function hook(event: string, entity: { payment?: string; refund?: string }, eventId = `evt_${uniq()}`) {
  const body = JSON.stringify({ event, created_at: Math.floor(Date.now() / 1000), payload: { ...(entity.payment ? { payment: { entity: { id: entity.payment } } } : {}), ...(entity.refund ? { refund: { entity: { id: entity.refund } } } : {}) } });
  const res = await request(app).post('/v1/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-event-id', eventId).set('x-razorpay-signature', createHmac('sha256', SECRET).update(body).digest('hex')).send(body);
  expect(res.status).toBe(200);
  return (await prisma.webhookEvent.findFirstOrThrow({ where: { eventId } })).id;
}
const processEvent = (id: number) => processWebhook({ prisma, providers: providers(), log }, id);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('webhooks', () => {
  it('payment.captured → re-fetched and applied → PLACED; an unknown payment → IGNORED; Razorpay unreachable → FAILED (retried later)', async () => {
    const g = await pending();
    const pay = fake.pay(g.providerOrderId);
    expect(await processEvent(await hook('payment.captured', { payment: pay.id }))).toBe('PROCESSED');
    expect(await order(g.orderNumber)).toMatchObject({ status: 'PLACED', paymentStatus: 'PAID' });
    expect(await processEvent(await hook('payment.captured', { payment: 'pay_doesnotexist' }))).toBe('IGNORED');
    const h = await pending();
    const other = fake.pay(h.providerOrderId);
    fake.fetchFails = true;
    expect(await processEvent(await hook('payment.captured', { payment: other.id }))).toBe('FAILED');
    expect((await order(h.orderNumber)).status).toBe('PENDING_PAYMENT');
  });

  it('AT-04: the inbox row is committed before 200; a worker dies mid-processing; the sweeper reclaims after the lease; paid exactly once', async () => {
    const g = await pending();
    const pay = fake.pay(g.providerOrderId);
    const id = await hook('payment.captured', { payment: pay.id });
    expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).status).toBe('RECEIVED');   // durable before the 200
    expect(queued).toContain(id);
    expect(await fn.webhookClaim(prisma, id, 1)).toBeTruthy();   // a worker took it… and was killed
    expect(await processEvent(id)).toBe('NOT_CLAIMED');            // lease still held
    await sleep(1100);
    expect(await sweepWebhooks(prisma, { add: async () => undefined as never })).toContain(id);
    expect(await processEvent(id)).toBe('PROCESSED');
    expect(await processEvent(id)).toBe('NOT_CLAIMED');
    const o = await order(g.orderNumber);
    expect([o.status, o.payments.length, o.payments[0]!.allocation, o.capturedAmount]).toEqual(['PLACED', 1, 'APPLIED', g.total]);
    expect(await prisma.outboxEvent.count({ where: { eventType: 'order.placed', aggregateId: g.orderNumber } })).toBe(1);
  });

  it('refund.processed for one of our refunds marks it processed (once); someone else\'s refund is IGNORED', async () => {
    const g = await pending();
    const first = fake.pay(g.providerOrderId);
    await g.verify(first.id);
    const second = fake.pay(g.providerOrderId);            // paid twice → EXCESS → automatic refund REQUESTED
    await processEvent(await hook('payment.captured', { payment: second.id }));
    const refund = (await order(g.orderNumber)).refunds[0]!;
    expect(refund).toMatchObject({ kind: 'EXCESS_CAPTURE', status: 'REQUESTED', amount: g.total });
    fake.refunds.push({ id: 'rfnd_ours', paymentId: second.id, amount: g.total, status: 'processed', receipt: null, notes: { aq_refund_id: String(refund.id) }, createdAt: Math.floor(Date.now() / 1000) });
    fake.refunds.push({ id: 'rfnd_dashboard', paymentId: first.id, amount: 100, status: 'processed', receipt: null, notes: {}, createdAt: Math.floor(Date.now() / 1000) });
    expect(await processEvent(await hook('refund.processed', { refund: 'rfnd_ours' }))).toBe('PROCESSED');
    expect(await processEvent(await hook('refund.processed', { refund: 'rfnd_ours' }))).toBe('PROCESSED');   // repeat: DUPLICATE inside
    expect(await processEvent(await hook('refund.processed', { refund: 'rfnd_dashboard' }))).toBe('IGNORED');
    const after = await order(g.orderNumber);
    expect(after.refunds[0]).toMatchObject({ status: 'PROCESSED', providerRefundId: 'rfnd_ours' });
    expect(after.exceptions.find((e) => e.type === 'EXCESS_CAPTURE')).toMatchObject({ status: 'RESOLVED' });
  });
});

describe('AT-05: one capture reported by verify, webhooks and the reconciler, concurrently and repeated', () => {
  it('exactly one APPLIED; coupon, sold count, cart, history and order.placed once; a late "authorized" keeps it CAPTURED', async () => {
    const c = await prisma.coupon.create({ data: { code: `AT05${uniq().toUpperCase()}`, title: 'x', type: 'FLAT', value: 5000, usageLimitPerCustomer: null } });
    const g = await pending({ couponCode: c.code });
    const pay = fake.pay(g.providerOrderId);
    const events = await Promise.all(['payment.captured', 'order.paid', 'payment.authorized', 'payment.captured'].map((e) => hook(e, { payment: pay.id })));
    await Promise.all([g.verify(pay.id), g.verify(pay.id), ...events.map(processEvent), reconcileAttempts(deps()), reconcileAttempts(deps()), g.verify(pay.id)]);
    const o = await order(g.orderNumber);
    expect(o.payments).toEqual([expect.objectContaining({ providerPaymentId: pay.id, allocation: 'APPLIED', status: 'CAPTURED' })]);
    expect(o).toMatchObject({ status: 'PLACED', paymentStatus: 'PAID', capturedAmount: g.total });
    expect(await prisma.coupon.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ reservedCount: 0, redeemedCount: 1 });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: g.p.productId } })).soldCount).toBe(1);
    expect(await prisma.cart.findFirstOrThrow({ where: { id: o.cartId! } })).toMatchObject({ status: 'CONVERTED' });
    expect(await prisma.orderStatusHistory.count({ where: { orderId: o.id, toValue: 'PLACED' } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { eventType: 'order.placed', aggregateId: g.orderNumber } })).toBe(1);
    await applySnapshot(prisma, { ...pay, status: 'authorized' }, 'WEBHOOK');   // late, out of order
    expect((await order(g.orderNumber)).payments[0]).toMatchObject({ status: 'CAPTURED', allocation: 'APPLIED' });
  });
});

describe('AT-06: two attempts both paid', () => {
  it('first APPLIED; second EXCESS + exception + automatic refund; captured_amount = the order total', async () => {
    const g = await pending({ price: 49_900 });
    fake.next = [];
    expect((await g.retry('RAZORPAY')).status).toBe(200);   // attempt 2 (nothing paid on 1 yet)
    const [a1, a2] = (await order(g.orderNumber)).paymentAttempts;
    const p2 = fake.pay(a2!.providerOrderId!);
    const p1 = fake.pay(a1!.providerOrderId!);              // the customer had paid in the old window too
    await processEvent(await hook('payment.captured', { payment: p2.id }));
    await processEvent(await hook('payment.captured', { payment: p1.id }));
    const o = await order(g.orderNumber);
    expect(o.payments.map((p) => [p.providerPaymentId, p.allocation]).sort()).toEqual([[p1.id, 'EXCESS'], [p2.id, 'APPLIED']].sort());
    expect(o.capturedAmount).toBe(o.total);
    expect(o.exceptions.map((e) => e.type)).toContain('EXCESS_CAPTURE');
    expect(o.refunds).toEqual([expect.objectContaining({ kind: 'EXCESS_CAPTURE', status: 'REQUESTED', amount: p1.amount })]);
  });
});

describe('AT-07: capture racing expiry and cancellation', () => {
  it('captured before the expiry job runs → the pre-expiry check places the order instead', async () => {
    const g = await pending();
    await prisma.order.update({ where: { orderNumber: g.orderNumber }, data: { expiresAt: new Date(Date.now() - 1000) } });
    fake.pay(g.providerOrderId);
    expect(await expirePending(deps())).toMatchObject({ expired: 0, placedInstead: 1 });
    expect((await order(g.orderNumber)).status).toBe('PLACED');
  });
  it('captured after expiry, stock still there → restored and placed', async () => {
    const g = await pending({ onHand: 5 });
    await prisma.order.update({ where: { orderNumber: g.orderNumber }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await expirePending(deps())).toMatchObject({ expired: 1 });
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: g.p.variantIds[0]! } })).reserved).toBe(0);
    await processEvent(await hook('payment.captured', { payment: fake.pay(g.providerOrderId).id }));
    expect(await order(g.orderNumber)).toMatchObject({ status: 'PLACED', paymentStatus: 'PAID' });
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: g.p.variantIds[0]! } })).reserved).toBe(1);
  });
  it('captured after expiry, stock sold meanwhile → refunded + exception; never placed', async () => {
    const g = await pending({ onHand: 1 });
    await prisma.order.update({ where: { orderNumber: g.orderNumber }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expirePending(deps());
    const buyer = await pending({ product: g.p });          // takes the last unit
    expect(buyer.orderNumber).not.toBe(g.orderNumber);
    await processEvent(await hook('payment.captured', { payment: fake.pay(g.providerOrderId).id }));
    const o = await order(g.orderNumber);
    expect(o.status).toBe('EXPIRED');
    expect(o.payments[0]!.allocation).toBe('LATE');
    expect(o.exceptions.map((e) => e.type)).toContain('LATE_CAPTURE_EXPIRED');
    expect(o.refunds).toEqual([expect.objectContaining({ kind: 'LATE_CAPTURE', status: 'REQUESTED' })]);
  });
  it('captured after cancellation → refunded + exception; never revived', async () => {
    const g = await pending();
    const o = await order(g.orderNumber);
    await prisma.$transaction((tx) => fn.releaseUnpaidOrder(tx, { orderId: o.id, newStatus: 'CANCELLED', reason: 'customer', actor: 'CUSTOMER' }));
    await processEvent(await hook('payment.captured', { payment: fake.pay(g.providerOrderId).id }));
    const after = await order(g.orderNumber);
    expect([after.status, after.payments[0]!.allocation]).toEqual(['CANCELLED', 'LATE']);
    expect(after.exceptions.map((e) => e.type)).toContain('LATE_CAPTURE_CANCELLED');
  });
});

describe('payments.reconcile-attempts', () => {
  it('a payment the browser never reported is applied; a stuck CREATING attempt is adopted by receipt', async () => {
    const g = await pending();
    fake.pay(g.providerOrderId);
    expect(await reconcileAttempts(deps())).toMatchObject({ applied: 1 });
    expect((await order(g.orderNumber)).status).toBe('PLACED');

    fake.next = ['created-then-crash'];
    const h = await pending().catch(() => null);
    expect(h).toBeNull();                                   // initiate answered 500 (crashed after Razorpay created it)
    const stuck = await prisma.paymentAttempt.findFirstOrThrow({ where: { status: 'CREATING' }, orderBy: { id: 'desc' } });
    expect(await reconcileAttempts(deps())).toMatchObject({ recovered: 0 });   // younger than 60 s: left alone
    await prisma.paymentAttempt.update({ where: { id: stuck.id }, data: { createdAt: new Date(Date.now() - 61_000) } });
    expect(await reconcileAttempts(deps())).toMatchObject({ recovered: 1 });
    expect((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe('CREATED');
  });

  it('UNLINKED: a capture reported before its provider order was mapped is recorded, then recovered once the mapping exists', async () => {
    fake.next = ['created-then-crash'];
    await pending().catch(() => null);
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { status: 'CREATING' }, orderBy: { id: 'desc' }, include: { order: true } });
    const pay = fake.pay(fake.orders.at(-1)!.id);
    await processEvent(await hook('payment.captured', { payment: pay.id }));
    expect(await prisma.payment.findUniqueOrThrow({ where: { providerPaymentId: pay.id } })).toMatchObject({ allocation: 'UNLINKED', orderId: null });
    expect(await prisma.paymentException.count({ where: { type: 'UNLINKED_PAYMENT', status: 'OPEN', payment: { providerPaymentId: pay.id } } })).toBe(1);
    await prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { createdAt: new Date(Date.now() - 61_000) } });
    fake.orderPayments = async () => [];   // the provider's per-order list lags: only the UNLINKED sweep can find it
    expect(await reconcileAttempts(deps())).toMatchObject({ recovered: 1, unlinked: 1 });
    expect(await prisma.payment.findUniqueOrThrow({ where: { providerPaymentId: pay.id } })).toMatchObject({ allocation: 'APPLIED', orderId: attempt.orderId });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: attempt.orderId } })).status).toBe('PLACED');
    expect(await prisma.paymentException.count({ where: { type: 'UNLINKED_PAYMENT', status: 'OPEN', payment: { providerPaymentId: pay.id } } })).toBe(0);
  });

  it('an authorization older than 15 minutes is captured; one that stays authorized raises CAPTURE_STUCK_AUTHORIZED', async () => {
    const g = await pending();
    fake.pay(g.providerOrderId, { status: 'authorized', createdAt: Math.floor(Date.now() / 1000) - 16 * 60 });
    expect(await reconcileAttempts(deps())).toMatchObject({ captured: 1 });
    expect(await order(g.orderNumber)).toMatchObject({ status: 'PLACED', paymentStatus: 'PAID' });
    const h = await pending();
    const stuck = fake.pay(h.providerOrderId, { status: 'authorized', createdAt: Math.floor(Date.now() / 1000) - 16 * 60 });
    fake.captureNext = ['definitive'];
    await reconcileAttempts(deps());
    expect(fake.captureCalls).toContain(stuck.id);
    expect(await order(h.orderNumber)).toMatchObject({ status: 'PENDING_PAYMENT', paymentStatus: 'PROCESSING' });
    expect((await order(h.orderNumber)).exceptions.map((e) => e.type)).toContain('CAPTURE_STUCK_AUTHORIZED');
  });

  it('an authorization voided by the provider returns the order to UNPAID, so it expires and releases stock and coupon once', async () => {
    const g = await pending();
    const auth = fake.pay(g.providerOrderId, { status: 'authorized' });
    await reconcileAttempts(deps());
    expect((await order(g.orderNumber)).paymentStatus).toBe('PROCESSING');
    fake.payments.find((p) => p.id === auth.id)!.status = 'refunded';
    fake.payments.find((p) => p.id === auth.id)!.amountRefunded = auth.amount;
    await reconcileAttempts(deps());
    expect(await order(g.orderNumber)).toMatchObject({ status: 'PENDING_PAYMENT', paymentStatus: 'UNPAID' });
    await prisma.order.update({ where: { orderNumber: g.orderNumber }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await expirePending(deps())).toMatchObject({ expired: 1 });
    expect((await order(g.orderNumber)).status).toBe('EXPIRED');
  });
});

describe('orders.expire-pending', () => {
  it('unpaid after the window → EXPIRED, stock released; Razorpay unreachable → postponed, never expired unchecked', async () => {
    const g = await pending({ onHand: 3 });
    await prisma.order.update({ where: { orderNumber: g.orderNumber }, data: { expiresAt: new Date(Date.now() - 1000) } });
    fake.fetchFails = true;
    expect(await expirePending(deps())).toMatchObject({ expired: 0, skipped: 1 });
    expect((await order(g.orderNumber)).status).toBe('PENDING_PAYMENT');
    fake.fetchFails = false;
    expect(await expirePending(deps())).toMatchObject({ expired: 1 });
    expect((await order(g.orderNumber)).status).toBe('EXPIRED');
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: g.p.variantIds[0]! } })).reserved).toBe(0);
    expect(await expirePending(deps())).toMatchObject({ expired: 0 });
  });
});

describe('payments.reconcile-daily', () => {
  it('a payment nobody reported is applied; a refund ArtQ never made → RECON_MISMATCH (once)', async () => {
    const g = await pending();
    const pay = fake.pay(g.providerOrderId);
    fake.refunds.push({ id: `rfnd_${uniq()}`, paymentId: pay.id, amount: 100, status: 'processed', receipt: null, notes: {}, createdAt: Math.floor(Date.now() / 1000) });
    const today = new Date();
    expect(await reconcileDaily(deps(), today)).toMatchObject({ payments: 1, unknownRefunds: 1 });
    expect((await order(g.orderNumber)).status).toBe('PLACED');
    await reconcileDaily(deps(), today);
    expect(await prisma.paymentException.count({ where: { type: 'RECON_MISMATCH', dedupeKey: `RECON_REFUND:${fake.refunds[0]!.id}` } })).toBe(1);
  });
});
