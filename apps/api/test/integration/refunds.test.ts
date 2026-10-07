// Task 5.4 on real PostgreSQL + Redis with the fake Razorpay: the refundable calculator, creating refunds (step-up,
// Idempotency-Key, validation), AT-08 (concurrent refunds on one item, on shipping, COD manual refunds: every limit
// holds, losers get 409 with the scope), refund.send outcomes (processed, pending → reconciled, unknown → the same
// attempt resent, created-but-answer-lost found by receipt, in progress, definitive → failed + retry with a new key,
// definitive but an earlier send succeeded, idempotency mismatch → exception, no resend), refund.failed webhooks, the
// reconciliation gate for refunds made outside ArtQ, and credit notes for invoiced orders.
import { randomUUID } from 'node:crypto';
import type { PrismaClient, UserRole } from '@prisma/client';
import type { Express } from 'express';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdminRouter } from '../../src/admin/router.js';
import { createApp } from '../../src/app.js';
import { adminAuthRouter } from '../../src/auth/admin-routes.js';
import { AuthService, DEFAULT_AUTH_TIMINGS } from '../../src/auth/service.js';
import { RedisSessionCache } from '../../src/auth/session-cache.js';
import * as fn from '../../src/db/functions.js';
import { hashPassword } from '../../src/lib/password.js';
import type { RateLimiter } from '../../src/middleware/rateLimit.js';
import { registerOrderRoutes } from '../../src/orders/admin-routes.js';
import { DispatchService } from '../../src/orders/dispatch.js';
import { FakeRazorpay } from '../../src/payments/razorpay.js';
import { processCreditNote, RefundAdminService, registerRefundRoutes } from '../../src/payments/refund-admin.js';
import { processRefundSend, reconcileRefunds } from '../../src/payments/refunds.js';
import { razorpayHandlers } from '../../src/payments/webhook-handlers.js';
import { seedGeo, seedSettings, seedShipping } from '../../src/seed/steps.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { attempt, capture, catalog, order, race, tx, uniq } from '../helpers/fixtures.js';
import { MemoryObjectStore } from '../helpers/memory-store.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const ORIGIN = 'http://localhost:5173';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const NO_LIMIT: RateLimiter = { hit: async () => ({ count: 0, resetMs: 60_000 }) };
const log = pino({ level: 'silent' });
let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express, variantId: number;
let ADMIN: { token: string }, STAFF: { token: string }, fake: FakeRazorpay, dispatch: DispatchService;
let stepUp = true;
const missingAudit: string[] = [];

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  await seedShipping(prisma); await seedGeo(prisma); await seedSettings(prisma);
  variantId = (await tx(prisma, (t) => catalog(t, [[{ price: 50_000, onHand: 1000 }]]))).products[0]!.variantIds[0]!;
  const cache = new RedisSessionCache(redis);
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: 'http://localhost:3000', adminUrl: ORIGIN });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log, hasRecentStepUp: async () => stepUp, onMissingAudit: (req) => missingAudit.push(`${req.method} ${req.originalUrl}`) });
  dispatch = new DispatchService(prisma, { store: new MemoryObjectStore(), buckets: { PUBLIC: 'p', PRIVATE: 'q' } });
  registerOrderRoutes(admin, prisma, dispatch);
  registerRefundRoutes(admin, prisma, log);
  app = createApp({ version: 't', origins: { storefront: ['http://localhost:3000'], admin: [ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} }, routes: [adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }), admin.router] });
  [ADMIN, STAFF] = [await staff('ADMIN'), await staff('STAFF')];
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });
beforeEach(() => { fake = new FakeRazorpay(); stepUp = true; missingAudit.length = 0; });

async function staff(role: UserRole) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  await prisma.user.create({ data: { email, name: role, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword('refund-password-1') } });
  return { token: (await request(app).post('/v1/admin/auth/login').set('Origin', ORIGIN).send({ email, password: 'refund-password-1' })).body.accessToken as string };
}
const get = (path: string, who = ADMIN) => request(app).get(`/v1/admin${path}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${who.token}`);
const post = (path: string, body: object = {}, who = ADMIN, key: string | null = randomUUID()) => {
  const r = request(app).post(`/v1/admin${path}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${who.token}`);
  return (key ? r.set('Idempotency-Key', key) : r).send(body);
};
const fields = (res: request.Response) => Object.fromEntries((res.body.error?.details ?? []).map((d: { path: string; message: string }) => [d.path, d.message]));
const deps = () => ({ prisma, provider: fake, log });
/** Runs the refund.send consumer for this refund's pending deliveries (other tests' requested refunds stay untouched). */
async function send(refundId: number) {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`SELECT d.id FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id
    JOIN refund_attempts a ON a.id = (e.payload->>'refund_attempt_id')::int
    WHERE d.consumer = 'refund.send' AND d.status NOT IN ('COMPLETED', 'DEAD') AND a.refund_id = ${refundId} ORDER BY d.id`;
  const out: string[] = [];
  for (const r of rows) out.push(await processRefundSend(deps(), Number(r.id)));
  return out;
}

/** 2 × ₹500 + shipping ₹70; prepaid (paid through the fake) or COD collected. */
async function paid() {
  const f = await tx(prisma, (t) => order(t, { lines: [{ variantId, qty: 2 }], shippingFee: 7000 }));
  await prisma.order.update({ where: { id: f.orderId }, data: { paymentStatus: 'UNPAID' } });
  const a = await tx(prisma, (t) => attempt(t, f.orderId, f.total));
  const p = fake.pay(a.providerOrderId, { amount: f.total });
  await tx(prisma, (t) => capture(t, { providerOrderId: a.providerOrderId, paymentId: p.id, amount: f.total }));
  const item = (await prisma.orderItem.findFirstOrThrow({ where: { orderId: f.orderId } })).id;
  return { ...f, item, paymentId: p.id };
}
async function codCollected() {
  const f = await tx(prisma, (t) => order(t, { lines: [{ variantId, qty: 2 }], method: 'COD', shippingFee: 7000, codFee: 4000 }));
  await prisma.order.update({ where: { id: f.orderId }, data: { paymentStatus: 'UNPAID' } });
  await tx(prisma, (t) => fn.placeCodOrder(t, f.orderId, 'CUSTOMER'));
  return { ...f, item: (await prisma.orderItem.findFirstOrThrow({ where: { orderId: f.orderId } })).id };
}
const refund = (orderId: number, body: object, key = randomUUID()) => post(`/orders/${orderId}/refunds`, { kind: 'GOODWILL', reason: 'Lid was scratched', ...body }, ADMIN, key);

describe('refundable calculator', () => {
  it('prepaid: back to the payment, everything available; COD not collected: blocked with the reason; collected: bank transfer; STAFF 403', async () => {
    const o = await paid();
    const v = (await get(`/orders/${o.orderId}/refundable`)).body;
    expect(v).toMatchObject({ method: 'ORIGINAL_PAYMENT', blockedReason: null, items: [{ orderItemId: o.item, quantity: 2, netAmount: 100_000, availableQty: 2, availableAmount: 100_000 }],
      shipping: { fee: 7000, available: 7000 }, total: { cap: o.total, available: o.total }, payment: { amount: o.total, available: o.total, reconciliationRequired: false } });
    const c = await codCollected();
    expect((await get(`/orders/${c.orderId}/refundable`)).body).toMatchObject({ method: null, blockedReason: expect.stringMatching(/^The cash hasn’t been collected yet/) });
    await prisma.order.update({ where: { id: c.orderId }, data: { paymentStatus: 'COD_COLLECTED' } });
    expect((await get(`/orders/${c.orderId}/refundable`)).body).toMatchObject({ method: 'MANUAL_BANK', payment: null, total: { cap: c.total } });
    expect((await get(`/orders/${o.orderId}/refundable`, STAFF)).status).toBe(403);
    expect((await get('/orders/999999/refundable')).status).toBe(404);
  });
});

describe('create and send', () => {
  it('a partial goodwill refund: 201 with attempt 1; sent with its key and stored body; processed → order partly refunded; replay returns the same refund', async () => {
    const o = await paid();
    const key = randomUUID();
    const res = await refund(o.orderId, { items: [{ orderItemId: o.item, quantity: 0, amount: 10_000 }] }, key);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ method: 'ORIGINAL_PAYMENT', status: 'REQUESTED', attempt: { no: 1, receipt: `AQR_${res.body.refundId}_A1` } });
    const again = await refund(o.orderId, { items: [{ orderItemId: o.item, quantity: 0, amount: 10_000 }] }, key);
    expect([again.status, again.headers['idempotent-replayed'], again.body.refundId]).toEqual([201, 'true', res.body.refundId]);
    expect(await send(res.body.refundId)).toEqual(['PROCESSED']);
    expect(fake.refundCalls).toEqual([{ paymentId: o.paymentId, key: `artq-refund-${res.body.refundId}-a1`, body: { payment_id: o.paymentId, amount: 10_000, speed: 'normal', receipt: `AQR_${res.body.refundId}_A1`, notes: { aq_refund_id: res.body.refundId, aq_attempt: 1 } } }]);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.orderId }, select: { paymentStatus: true, refundedAmount: true } })).toEqual({ paymentStatus: 'PARTIALLY_REFUNDED', refundedAmount: 10_000 });
    expect((await get(`/orders/${o.orderId}/refundable`)).body.items[0]).toMatchObject({ refundedAmount: 10_000, availableAmount: 90_000 });
    expect(await prisma.auditLog.count({ where: { action: 'refund.create', entityId: String(res.body.refundId) } })).toBe(1);
    expect(missingAudit).toEqual([]);
  });

  it('refused: no step-up (401), STAFF (403), no key (400), validation on fields, under ₹1 online, an item from another order', async () => {
    const o = await paid();
    stepUp = false;
    expect((await refund(o.orderId, { items: [{ orderItemId: o.item, quantity: 0, amount: 1000 }] })).body.error.code).toBe('STEP_UP_REQUIRED');
    stepUp = true;
    expect((await post(`/orders/${o.orderId}/refunds`, { kind: 'GOODWILL', reason: 'x x x', shippingAmount: 100 }, STAFF)).status).toBe(403);
    expect((await post(`/orders/${o.orderId}/refunds`, { kind: 'GOODWILL', reason: 'x x x', shippingAmount: 100 }, ADMIN, null)).status).toBe(400);
    expect(fields(await refund(o.orderId, { reason: '' }))).toEqual({ reason: 'Say why you are refunding', '': 'Enter an amount to refund' });
    expect(fields(await refund(o.orderId, { shippingAmount: 99 }))).toEqual({ '': 'Razorpay can’t refund less than ₹1' });
    const other = await paid();
    expect(fields(await refund(o.orderId, { items: [{ orderItemId: other.item, quantity: 0, amount: 1000 }] }))).toEqual({ 'items.0.orderItemId': 'This item is not in the order' });
    expect(await prisma.refund.count({ where: { orderId: o.orderId } })).toBe(0);
  });
});

describe('AT-08: every limit holds under concurrency', () => {
  it('five refunds of the same whole item at once while the payment has room: one wins, the rest 409 scope item', async () => {
    const o = await paid();
    const res = await Promise.all(Array.from({ length: 5 }, () => refund(o.orderId, { items: [{ orderItemId: o.item, quantity: 2, amount: 100_000 }] })));
    expect(res.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
    const lost = res.find((r) => r.status === 409)!;
    expect(lost.body.error).toMatchObject({ code: 'REFUND_EXCEEDS_CAPACITY', details: { scope: 'item', orderItemId: o.item } });
    expect(await prisma.orderItem.findUniqueOrThrow({ where: { id: o.item }, select: { refundReservedAmount: true, refundReservedQty: true } })).toEqual({ refundReservedAmount: 100_000, refundReservedQty: 2 });
    expect((await prisma.payment.findFirstOrThrow({ where: { orderId: o.orderId } })).refundReserved).toBe(100_000);
  });

  it('four shipping refunds at once: one; two halves of the item at once both fit; a third over the item is refused', async () => {
    const o = await paid();
    const ship = await Promise.all(Array.from({ length: 4 }, () => refund(o.orderId, { shippingAmount: 7000 })));
    expect(ship.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect(ship.find((r) => r.status === 409)!.body.error.details.scope).toBe('order');
    const halves = await Promise.all([1, 2].map(() => refund(o.orderId, { items: [{ orderItemId: o.item, quantity: 1, amount: 50_000 }] })));
    expect(halves.map((r) => r.status)).toEqual([201, 201]);
    expect((await refund(o.orderId, { items: [{ orderItemId: o.item, quantity: 0, amount: 100 }] })).body.error.details.scope).toBe('item');
    expect((await get(`/orders/${o.orderId}/refundable`)).body).toMatchObject({ total: { available: 0 }, payment: { available: 0 } });
  });

  it('COD manual refunds: three full refunds at once → one; recorded paid with the reference (step-up) → REFUNDED; another one cancelled releases capacity', async () => {
    const c = await codCollected();
    await prisma.order.update({ where: { id: c.orderId }, data: { paymentStatus: 'COD_COLLECTED' } });
    const full = { items: [{ orderItemId: c.item, quantity: 2, amount: 100_000 }], shippingAmount: 7000, codFeeAmount: 4000 };
    const three = await Promise.all(Array.from({ length: 3 }, () => refund(c.orderId, full)));
    expect(three.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const won = three.find((r) => r.status === 201)!.body;
    expect(won).toMatchObject({ method: 'MANUAL_BANK', attempt: null });
    expect(fields(await post(`/refunds/${won.refundId}/manual-processed`, { manualReference: 'x' }))).toEqual({ manualReference: 'Enter the bank or UPI reference' });
    stepUp = false;
    expect((await post(`/refunds/${won.refundId}/manual-processed`, { manualReference: 'UPI 4512' })).body.error.code).toBe('STEP_UP_REQUIRED');
    stepUp = true;
    expect((await post(`/refunds/${won.refundId}/manual-processed`, { manualReference: 'UPI 4512' })).body).toMatchObject({ status: 'PROCESSED', manualReference: 'UPI 4512', actions: [] });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: c.orderId } })).paymentStatus).toBe('REFUNDED');
    expect((await post(`/refunds/${won.refundId}/manual-processed`, { manualReference: 'UPI 4512' })).status).toBe(409);

    const d = await codCollected();
    await prisma.order.update({ where: { id: d.orderId }, data: { paymentStatus: 'COD_COLLECTED' } });
    const r = (await refund(d.orderId, { shippingAmount: 7000 })).body;
    expect((await get(`/refunds?orderId=${d.orderId}`)).body.data[0]).toMatchObject({ id: r.refundId, actions: ['manual-processed', 'cancel'] });
    expect((await post(`/refunds/${r.refundId}/cancel`)).body).toMatchObject({ status: 'CANCELLED', actions: [] });
    expect((await get(`/orders/${d.orderId}/refundable`)).body.shipping.available).toBe(7000);
    const online = await paid();
    const or = (await refund(online.orderId, { shippingAmount: 7000 })).body;
    expect((await post(`/refunds/${or.refundId}/cancel`)).body.error.code).toBe('REFUND_NOT_CANCELLABLE');
  });
});

describe('refund.send outcomes and reconciliation', () => {
  it('timeout → UNKNOWN; the reconciler finds nothing at Razorpay and resends the SAME attempt (same key, same body)', async () => {
    const o = await paid();
    const r = (await refund(o.orderId, { shippingAmount: 7000 })).body;
    fake.refundNext = ['unknown'];
    expect(await send(r.refundId)).toEqual(['UNKNOWN']);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: r.refundId } })).status).toBe('UNKNOWN');
    expect(await reconcileRefunds(deps(), { unknownAfterMs: 0 })).toMatchObject({ resent: 1, matched: 0 });
    expect(fake.refundCalls).toHaveLength(2);
    expect(fake.refundCalls[1]).toEqual(fake.refundCalls[0]);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: r.refundId } })).status).toBe('PROCESSED');
  });

  it('created at Razorpay but the answer was lost: the reconciler finds it by receipt and never sends a second refund', async () => {
    const o = await paid();
    const r = (await refund(o.orderId, { shippingAmount: 7000 })).body;
    fake.refundNext = ['created-then-unknown'];
    await send(r.refundId);
    expect(await reconcileRefunds(deps(), { unknownAfterMs: 0 })).toMatchObject({ matched: 1, resent: 0 });
    expect(fake.refundCalls).toHaveLength(1);
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: r.refundId }, select: { status: true, providerRefundId: true } })).toEqual({ status: 'PROCESSED', providerRefundId: fake.refunds[0]!.id });
  });

  it('409 still in progress → UNKNOWN; definitive refusal → FAILED (capacity released, exception) → retry makes attempt 2 with a new key and receipt', async () => {
    const o = await paid();
    const r = (await refund(o.orderId, { shippingAmount: 7000 })).body;
    fake.refundNext = ['in-progress'];
    expect(await send(r.refundId)).toEqual(['UNKNOWN']);
    fake.refundNext = ['definitive'];
    await reconcileRefunds(deps(), { unknownAfterMs: 0 });
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: r.refundId }, select: { status: true, failureReason: true } })).toEqual({ status: 'FAILED', failureReason: 'The refund amount provided is greater than amount captured' });
    expect((await get(`/orders/${o.orderId}/refundable`)).body.shipping.available).toBe(7000);
    expect(await prisma.paymentException.count({ where: { refundId: r.refundId, type: 'REFUND_FAILED' } })).toBe(1);
    stepUp = false;
    expect((await post(`/refunds/${r.refundId}/retry`)).body.error.code).toBe('STEP_UP_REQUIRED');
    stepUp = true;
    const retry = await post(`/refunds/${r.refundId}/retry`);
    expect(retry.status).toBe(202);
    expect(retry.body).toMatchObject({ status: 'REQUESTED', attempts: [{ no: 1, status: 'FAILED' }, { no: 2, key: `artq-refund-${r.refundId}-a2`, receipt: `AQR_${r.refundId}_A2` }] });
    expect(await send(r.refundId)).toEqual(['PROCESSED']);
    expect((await post(`/refunds/${r.refundId}/retry`)).body.error.code).toBe('REFUND_NOT_RETRYABLE');
  });

  it('a definitive refusal after an earlier send already succeeded is recorded as success (the refund list is checked first)', async () => {
    const o = await paid();
    const r = (await refund(o.orderId, { shippingAmount: 7000 })).body;
    const a = await prisma.refundAttempt.findFirstOrThrow({ where: { refundId: r.refundId } });
    await fake.createRefund(o.paymentId, a.request as never, 'an-earlier-key-1');   // same receipt, made earlier
    fake.refundNext = ['definitive'];
    expect(await send(r.refundId)).toEqual(['PROCESSED']);
  });

  it('same key, different body (should never happen): MISMATCH, exception, capacity kept, never resent automatically', async () => {
    const o = await paid();
    const r = (await refund(o.orderId, { shippingAmount: 7000 })).body;
    const a = await prisma.refundAttempt.findFirstOrThrow({ where: { refundId: r.refundId } });
    await fake.createRefund(o.paymentId, { ...(a.request as object), amount: 1 } as never, a.providerIdempotencyKey);
    expect(await send(r.refundId)).toEqual(['MISMATCH']);
    expect(await prisma.paymentException.count({ where: { refundId: r.refundId, type: 'REFUND_IDEMPOTENCY_MISMATCH' } })).toBe(1);
    expect(await reconcileRefunds(deps(), { unknownAfterMs: 0 })).toMatchObject({ resent: 0 });
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: r.refundId } })).status).toBe('UNKNOWN');
    expect((await get(`/orders/${o.orderId}/refundable`)).body.shipping.available).toBe(0);
  });

  it('pending at Razorpay → PENDING; processed later → the reconciler marks it; a refund.failed webhook releases the capacity', async () => {
    const o = await paid();
    const r = (await refund(o.orderId, { shippingAmount: 7000 })).body;
    fake.refundNext = ['pending'];
    expect(await send(r.refundId)).toEqual(['PENDING']);
    fake.refunds.at(-1)!.status = 'processed';
    expect(await reconcileRefunds(deps())).toMatchObject({ processed: 1 });
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: r.refundId } })).status).toBe('PROCESSED');

    const p = await paid();
    const q = (await refund(p.orderId, { shippingAmount: 7000 })).body;
    fake.refundNext = ['pending'];
    await send(q.refundId);
    const fr = fake.refunds.at(-1)!;
    fr.status = 'failed';
    const h = razorpayHandlers(fake)['refund.failed']!;
    const fetched = await h.fetch({ payload: { payload: { refund: { entity: { id: fr.id } } } } } as never);
    expect(await prisma.$transaction((t) => h.apply(t, fetched))).toBe('PROCESSED');
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: q.refundId } })).status).toBe('FAILED');
    expect((await get(`/orders/${p.orderId}/refundable`)).body.shipping.available).toBe(7000);
  });

  it('refunds made in the Razorpay dashboard close the gate (409 until reconciled); the reconciler records them once and reopens it', async () => {
    const o = await paid();
    await fake.createRefund(o.paymentId, { amount: 20_000, speed: 'normal', receipt: 'dashboard-1', notes: {} }, 'dashboard-key-1');
    await prisma.payment.updateMany({ where: { providerPaymentId: o.paymentId }, data: { providerAmountRefunded: 20_000 } });
    const blocked = await refund(o.orderId, { shippingAmount: 7000 });
    expect(blocked.body.error.code).toBe('REFUND_RECONCILIATION_REQUIRED');
    expect((await get(`/orders/${o.orderId}/refundable`)).body.payment.reconciliationRequired).toBe(true);
    expect(await reconcileRefunds(deps())).toMatchObject({ gates: 1 });
    expect(await prisma.refund.findFirstOrThrow({ where: { orderId: o.orderId, kind: 'PROVIDER_INITIATED' } })).toMatchObject({ amount: 20_000, status: 'PROCESSED' });
    expect((await get(`/orders/${o.orderId}/refundable`)).body).toMatchObject({ payment: { reconciliationRequired: false, available: o.total - 20_000 } });
    expect((await refund(o.orderId, { shippingAmount: 7000 })).status).toBe(201);
    expect(await reconcileRefunds(deps())).toMatchObject({ gates: 0 });
  });

  it('five concurrent sends of one attempt (outbox redelivery): Razorpay sees one refund, the ledger counts it once', async () => {
    const o = await paid();
    const r = (await refund(o.orderId, { shippingAmount: 7000 })).body;
    const a = await prisma.refundAttempt.findFirstOrThrow({ where: { refundId: r.refundId } });
    const { sendRefundAttempt } = await import('../../src/payments/refunds.js');
    const out = await race(5, () => sendRefundAttempt(deps(), a.id));
    expect(out.ok).toBe(5);
    expect(new Set(fake.refundCalls.map((c) => c.key)).size).toBe(1);
    expect(fake.refunds.filter((x) => x.paymentId === o.paymentId)).toHaveLength(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).refundedAmount).toBe(7000);
  });
});

describe('credit notes', () => {
  it('a processed refund of an invoiced order gets one credit note (CN/<fy>/…) against the invoice; before dispatch none', async () => {
    const o = await paid();
    await prisma.order.update({ where: { id: o.orderId }, data: { status: 'CONFIRMED', fulfilmentStatus: 'PACKED', shipStateCode: '32' } });
    await prisma.$transaction(async (t) => fn.dispatchOrder(t, { orderId: o.orderId, courier: 'DTDC', awb: `CN${uniq()}`, trackingUrl: null, weightG: null, invoice: await dispatch.invoiceFor(o.orderId), notify: false, actorId: null }));
    const r = (await refund(o.orderId, { items: [{ orderItemId: o.item, quantity: 1, amount: 50_000 }], shippingAmount: 7000 })).body;
    await send(r.refundId);
    const [d] = await prisma.$queryRaw<{ id: bigint }[]>`SELECT d.id FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id WHERE d.consumer = 'invoice.credit_note' AND e.payload->>'refund_id' = ${String(r.refundId)}`;
    const refunds = new RefundAdminService(prisma);
    expect(await processCreditNote({ prisma, refunds, log }, Number(d!.id))).toBe('ISSUED');
    const cn = await prisma.invoice.findFirstOrThrow({ where: { refundId: r.refundId, kind: 'CREDIT_NOTE' }, include: { original: true } });
    expect(cn).toMatchObject({ grandTotal: 57_000, placeOfSupply: '32', original: { kind: 'TAX_INVOICE', orderId: o.orderId } });
    expect(cn.number).toMatch(/^CN\/\d{2}-\d{2}\/\d{6}$/);
    expect(cn.taxableTotal + cn.cgstTotal + cn.sgstTotal).toBe(57_000);
    expect((await refunds.creditNote(r.refundId)).status).toBe('DUPLICATE');
    expect((await get(`/orders/${o.orderId}/credit-notes/${cn.id}`)).body).toMatchObject({ number: cn.number, url: expect.stringContaining('download=') });
    expect(await dispatch.ensurePdf(cn.id)).toBeGreaterThan(0);

    const before = await paid();
    const x = (await refund(before.orderId, { shippingAmount: 7000 })).body;
    await send(x.refundId);
    expect((await refunds.creditNote(x.refundId)).status).toBe('SKIPPED');
  });
});
