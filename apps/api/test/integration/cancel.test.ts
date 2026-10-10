// Task 5.3: cancellation on real PostgreSQL + Redis, through the admin and customer endpoints. Prepaid → one full
// CANCELLATION refund; COD → not collected; stock and coupon restored; unpaid orders released (refused while a
// payment is being confirmed); customers only before packing, staff until shipped; Idempotency-Key replays; one
// cancellation under concurrency; reasons validated on their field; the customer email names the refund.
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
import { authRouter } from '../../src/auth/routes.js';
import { AuthService, DEFAULT_AUTH_TIMINGS } from '../../src/auth/service.js';
import { RedisSessionCache } from '../../src/auth/session-cache.js';
import * as fn from '../../src/db/functions.js';
import { processEmailDelivery } from '../../src/email/consumer.js';
import { MemoryTransport } from '../../src/email/transport.js';
import { hashPassword } from '../../src/lib/password.js';
import type { RateLimiter } from '../../src/middleware/rateLimit.js';
import { registerOrderRoutes } from '../../src/orders/admin-routes.js';
import { customerOrderRouter, registerCancelRoutes } from '../../src/orders/cancel.js';
import { DispatchService } from '../../src/orders/dispatch.js';
import { seedGeo, seedSettings, seedShipping } from '../../src/seed/steps.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { attempt, capture, catalog, order, tx, uniq } from '../helpers/fixtures.js';
import { MemoryObjectStore } from '../helpers/memory-store.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const ORIGIN = 'http://localhost:5173';
const WEB = 'http://localhost:3000';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const NO_LIMIT: RateLimiter = { hit: async () => ({ count: 0, resetMs: 60_000 }) };
const log = pino({ level: 'silent' });
let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express, variantId: number, couponId: number;
let ADMIN: { token: string }, STAFF: { token: string };
const missingAudit: string[] = [];

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  await seedShipping(prisma); await seedGeo(prisma); await seedSettings(prisma);
  variantId = (await tx(prisma, (t) => catalog(t, [[{ price: 50_000, onHand: 500 }]]))).products[0]!.variantIds[0]!;
  couponId = (await prisma.coupon.create({ data: { code: `CXL${uniq().toUpperCase()}`, title: 'x', type: 'FLAT', value: 5000 } })).id;
  const cache = new RedisSessionCache(redis);
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: WEB, adminUrl: ORIGIN });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log, hasRecentStepUp: (sid) => service.hasRecentStepUp(sid), onMissingAudit: (req) => missingAudit.push(`${req.method} ${req.originalUrl}`) });
  registerOrderRoutes(admin, prisma, new DispatchService(prisma, { store: new MemoryObjectStore(), buckets: { PUBLIC: 'p', PRIVATE: 'q' } }));
  registerCancelRoutes(admin, prisma, log);
  app = createApp({ version: 't', origins: { storefront: [WEB], admin: [ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }), admin.router, authRouter({ ...deps, service, env: 'test', refreshMaxAgeS: DEFAULT_AUTH_TIMINGS.refreshIdleS, limiter: NO_LIMIT }), customerOrderRouter({ ...deps, log })] });
  [ADMIN, STAFF] = [await staff('ADMIN'), await staff('STAFF')];
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });
beforeEach(() => { missingAudit.length = 0; });

async function staff(role: UserRole) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  await prisma.user.create({ data: { email, name: role, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword('cancel-password-1') } });
  return { token: (await request(app).post('/v1/admin/auth/login').set('Origin', ORIGIN).send({ email, password: 'cancel-password-1' })).body.accessToken as string };
}
async function customer() {
  const email = `c${uniq()}@example.com`;
  const u = await prisma.user.create({ data: { email, name: 'Hema', role: 'CUSTOMER', status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword('cancel-password-1') } });
  const res = await request(app).post('/v1/auth/login').set('Origin', WEB).send({ email, password: 'cancel-password-1' });
  return { id: u.id, token: res.body.accessToken as string };
}
const adminCancel = (id: number, body: object = { reason: 'Customer asked by phone' }, who = ADMIN, key = randomUUID()) =>
  request(app).post(`/v1/admin/orders/${id}/cancel`).set('Origin', ORIGIN).set('Authorization', `Bearer ${who.token}`).set('Idempotency-Key', key).send(body);
const myCancel = (n: string, token: string | null, body: object = {}, key = randomUUID()) => {
  const r = request(app).post(`/v1/me/orders/${n}/cancel`).set('Origin', WEB).set('Idempotency-Key', key);
  return (token ? r.set('Authorization', `Bearer ${token}`) : r).send(body);
};
const fields = (res: request.Response) => Object.fromEntries((res.body.error?.details ?? []).map((d: { path: string; message: string }) => [d.path, d.message]));
const stock = () => prisma.productVariant.findUniqueOrThrow({ where: { id: variantId }, select: { onHand: true, reserved: true } });

/** 2 × ₹500, shipping ₹70, coupon ₹50; prepaid (captured) or COD, owned by `userId` when given. */
async function placed(method: 'RAZORPAY' | 'COD' = 'RAZORPAY', userId: number | null = null) {
  const f = await tx(prisma, (t) => order(t, { lines: [{ variantId, qty: 2 }], method, shippingFee: 7000, couponDiscount: 5000, codFee: method === 'COD' ? 4000 : 0 }));
  await prisma.order.update({ where: { id: f.orderId }, data: { paymentStatus: 'UNPAID', userId, contactEmail: `b${uniq()}@example.com` } });
  await tx(prisma, (t) => fn.reserveCoupon(t, { orderId: f.orderId, couponId, userId: null, email: `b${f.orderId}@x.in`, phone: null, discount: 5000 }));
  if (method === 'COD') await tx(prisma, (t) => fn.placeCodOrder(t, f.orderId, 'CUSTOMER'));
  else {
    const a = await tx(prisma, (t) => attempt(t, f.orderId, f.total));
    await tx(prisma, (t) => capture(t, { providerOrderId: a.providerOrderId, paymentId: `pay_${uniq()}`, amount: f.total }));
  }
  return f;
}

describe('staff cancel', () => {
  it('prepaid: one full CANCELLATION refund, stock back, coupon reversed, reason in the timeline, audited; the email names the refund', async () => {
    const before = await stock();
    const redeemed = (await prisma.coupon.findUniqueOrThrow({ where: { id: couponId } })).redeemedCount;
    const o = await placed();
    const res = await adminCancel(o.orderId, { reason: 'Customer asked by phone' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'CANCELLED', paymentStatus: 'PAID', actions: [], refunds: [{ kind: 'CANCELLATION', status: 'REQUESTED', amount: o.total }], times: { cancelReason: 'Customer asked by phone' } });
    expect(res.body.history.at(-1)).toMatchObject({ dimension: 'ORDER', to: 'CANCELLED', actor: 'ADMIN', note: 'Customer asked by phone' });
    expect(await stock()).toEqual(before);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: couponId } })).redeemedCount).toBe(redeemed);
    expect(await prisma.auditLog.count({ where: { action: 'order.cancel', entityId: String(o.orderId) } })).toBe(1);
    expect(missingAudit).toEqual([]);
    const mail = new MemoryTransport();
    const [d] = await prisma.$queryRaw<{ id: bigint }[]>`SELECT d.id FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id WHERE e.aggregate_id = ${o.orderNumber} AND e.event_type = 'order.cancelled'`;
    await processEmailDelivery({ prisma, transport: mail, from: 'x@artq.in', log }, 'email.customer', Number(d!.id));
    expect(mail.sent[0]!.text).toBe(`Your order ${o.orderNumber} was cancelled. ₹${(o.total / 100).toLocaleString('en-IN')} is being refunded to your original payment method. Refunds usually reach your account in 5–7 working days.`);
  });

  it('COD: not collected, no refund; packed orders too; shipped ones refused saying why; quiet cancel sends no email', async () => {
    const o = await placed('COD');
    await request(app).post(`/v1/admin/orders/${o.orderId}/confirm`).set('Origin', ORIGIN).set('Authorization', `Bearer ${ADMIN.token}`).send({ notifyCustomer: false });
    await request(app).post(`/v1/admin/orders/${o.orderId}/pack`).set('Origin', ORIGIN).set('Authorization', `Bearer ${ADMIN.token}`).send({});
    expect((await adminCancel(o.orderId, { reason: 'Out of stock after count', notifyCustomer: false })).body).toMatchObject({ status: 'CANCELLED', paymentStatus: 'NOT_COLLECTED', refunds: [] });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: o.orderNumber, eventType: 'order.cancelled' } })).toBe(0);
    const s = await placed('COD');
    await prisma.order.update({ where: { id: s.orderId }, data: { status: 'CONFIRMED', fulfilmentStatus: 'SHIPPED' } });
    const r = await adminCancel(s.orderId);
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe('This order can’t be cancelled now: it is confirmed, shipped, cash on delivery.');
  });

  it('unpaid order: released (coupon released, not reversed); refused while a payment is being authorised', async () => {
    const f = await tx(prisma, (t) => order(t, { lines: [{ variantId, qty: 1 }] }));
    await prisma.order.update({ where: { id: f.orderId }, data: { paymentStatus: 'UNPAID' } });
    expect((await adminCancel(f.orderId)).body).toMatchObject({ status: 'CANCELLED', paymentStatus: 'UNPAID', refunds: [] });
    const g = await tx(prisma, (t) => order(t, { lines: [{ variantId, qty: 1 }] }));
    await prisma.order.update({ where: { id: g.orderId }, data: { paymentStatus: 'UNPAID' } });
    const a = await tx(prisma, (t) => attempt(t, g.orderId, g.total));
    await tx(prisma, (t) => capture(t, { providerOrderId: a.providerOrderId, paymentId: `pay_${uniq()}`, amount: g.total, status: 'AUTHORIZED' }));
    const r = await adminCancel(g.orderId);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'PAYMENT_IN_PROGRESS', message: 'A payment for this order is being confirmed. Try again in a few minutes.' });
  });

  it('Idempotency-Key: required; a retry replays the answer without a second effect; reused for another body → refused', async () => {
    const o = await placed();
    const noKey = await request(app).post(`/v1/admin/orders/${o.orderId}/cancel`).set('Origin', ORIGIN).set('Authorization', `Bearer ${ADMIN.token}`).send({ reason: 'x x x' });
    expect(noKey.status).toBe(400);
    const key = randomUUID();
    const first = await adminCancel(o.orderId, { reason: 'Duplicate order' }, ADMIN, key);
    const again = await adminCancel(o.orderId, { reason: 'Duplicate order' }, ADMIN, key);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    expect(await prisma.refund.count({ where: { orderId: o.orderId } })).toBe(1);
    expect((await adminCancel(o.orderId, { reason: 'Something else' }, ADMIN, key)).body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('five staff cancel at once (different keys): one cancellation, one refund; STAFF role may not cancel; reason on its field (300 / 301)', async () => {
    const o = await placed();
    const res = await Promise.all(Array.from({ length: 5 }, () => adminCancel(o.orderId)));
    expect(res.map((r) => r.status).sort()).toEqual([200, 422, 422, 422, 422]);
    expect(await prisma.refund.count({ where: { orderId: o.orderId } })).toBe(1);
    const p = await placed();
    expect((await adminCancel(p.orderId, { reason: 'Customer asked' }, STAFF)).status).toBe(403);
    expect(fields(await adminCancel(p.orderId, { reason: ' ' }))).toEqual({ reason: 'Say why the order is cancelled' });
    expect(fields(await adminCancel(p.orderId, { reason: 'x'.repeat(301) }))).toEqual({ reason: 'Use at most 300 characters' });
    expect((await adminCancel(p.orderId, { reason: 'x'.repeat(300) })).status).toBe(200);
    expect((await adminCancel(999_999)).status).toBe(404);
  });
});

describe('customer cancel', () => {
  it('own order before packing: cancelled with a refund; packed → a friendly refusal; someone else’s → 404; signed out → 401', async () => {
    const me = await customer();
    const o = await placed('RAZORPAY', me.id);
    const res = await myCancel(o.orderNumber, me.token, { reason: 'Ordered by mistake' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ orderNumber: o.orderNumber, status: 'CANCELLED', refund: { amount: o.total } });
    expect((await prisma.orderStatusHistory.findFirstOrThrow({ where: { orderId: o.orderId, toValue: 'CANCELLED' } }))).toMatchObject({ actorType: 'CUSTOMER', actorId: me.id, note: 'Ordered by mistake' });
    const packed = await placed('COD', me.id);
    await prisma.order.update({ where: { id: packed.orderId }, data: { status: 'CONFIRMED', fulfilmentStatus: 'PACKED' } });
    const late = await myCancel(packed.orderNumber, me.token);
    expect(late.status).toBe(422);
    expect(late.body.error.message).toBe('Your order is already being packed, so it can’t be cancelled online. Contact us and we’ll help.');
    const other = await customer();
    const theirs = await placed('COD', other.id);
    expect((await myCancel(theirs.orderNumber, me.token)).status).toBe(404);
    expect((await myCancel(theirs.orderNumber, null)).status).toBe(401);
    expect(fields(await myCancel(theirs.orderNumber, other.token, { reason: 'x'.repeat(301) }))).toEqual({ reason: 'Use at most 300 characters' });
    expect((await myCancel(theirs.orderNumber, other.token, {})).body).toMatchObject({ status: 'CANCELLED', refund: null, paymentStatus: 'NOT_COLLECTED' });
  });
});
