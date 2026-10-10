// Task 5.9 on real PostgreSQL + Redis: the dashboard (range bounds in India time, revenue after refunds, cancelled and
// pending orders left out, hourly/daily series, pending actions, low stock, top products), Customers (search, masked
// contact for STAFF, detail with orders and addresses, staff note limit, block ends sessions and refuses login,
// unblock, staff accounts not reachable), Restock Requests (grouped by variant, Notify now only when available and
// once a day, the restock.notify consumer emailing each waiting customer once, cancel a request).
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
import { registerCustomerRoutes } from '../../src/customers/admin.js';
import { DashboardService, rangeBounds } from '../../src/dashboard/service.js';
import { registerDashboardRoutes } from '../../src/dashboard/routes.js';
import { processEmailDelivery } from '../../src/email/consumer.js';
import { MemoryTransport } from '../../src/email/transport.js';
import { hashPassword } from '../../src/lib/password.js';
import { processRestockNotify, registerRestockRoutes } from '../../src/restock/service.js';
import { seedGeo, seedSettings, seedShipping } from '../../src/seed/steps.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { catalog, order, tx, uniq } from '../helpers/fixtures.js';
import { liveProduct } from '../helpers/storefront-fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const ORIGIN = 'http://localhost:5173';
const WEB = 'http://localhost:3000';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const log = pino({ level: 'silent' });
const NO_LIMIT = { hit: async () => ({ count: 0, resetMs: 60_000 }) };
let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express;
let ADMIN: { token: string }, STAFF: { token: string }, variantId: number, productId: number;
const missingAudit: string[] = [];

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  await seedShipping(prisma); await seedGeo(prisma); await seedSettings(prisma);
  const cat = await tx(prisma, (t) => catalog(t, [[{ price: 50_000, onHand: 100 }]]));
  [variantId, productId] = [cat.products[0]!.variantIds[0]!, cat.products[0]!.productId];
  const cache = new RedisSessionCache(redis);
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: WEB, adminUrl: ORIGIN });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log, hasRecentStepUp: async () => true, onMissingAudit: (req) => missingAudit.push(`${req.method} ${req.originalUrl}`) });
  registerCustomerRoutes(admin, prisma, service);
  registerRestockRoutes(admin, prisma);
  registerDashboardRoutes(admin, prisma);
  app = createApp({ version: 't', origins: { storefront: [WEB], admin: [ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }), authRouter({ ...deps, service, env: 'test', refreshMaxAgeS: DEFAULT_AUTH_TIMINGS.refreshIdleS, limiter: NO_LIMIT }), admin.router] });
  [ADMIN, STAFF] = [await staff('ADMIN'), await staff('STAFF')];
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });
beforeEach(() => { missingAudit.length = 0; });

async function staff(role: UserRole) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  await prisma.user.create({ data: { email, name: role, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword('insight-password-1') } });
  return { token: (await request(app).post('/v1/admin/auth/login').set('Origin', ORIGIN).send({ email, password: 'insight-password-1' })).body.accessToken as string };
}
const get = (path: string, who = ADMIN) => request(app).get(`/v1/admin${path}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${who.token}`);
const send = (method: 'post' | 'patch' | 'delete', path: string, body: object = {}, who = ADMIN) => request(app)[method](`/v1/admin${path}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${who.token}`).send(body);
const fields = (res: request.Response) => Object.fromEntries((res.body.error?.details ?? []).map((d: { path: string; message: string }) => [d.path, d.message]));
/** An order placed at `at` (status / refunded as given). */
async function placedAt(at: Date, o: { status?: 'PLACED' | 'CANCELLED' | 'PENDING_PAYMENT'; refunded?: number; userId?: number | null; qty?: number } = {}) {
  const f = await tx(prisma, (t) => order(t, { lines: [{ variantId, qty: o.qty ?? 1 }], reserve: false }));
  await prisma.order.update({ where: { id: f.orderId }, data: { status: o.status ?? 'PLACED', paymentStatus: 'PAID', placedAt: at, createdAt: at, capturedAmount: f.total, refundReservedTotal: o.refunded ?? 0, refundedAmount: o.refunded ?? 0, userId: o.userId ?? null } });
  return f;
}

describe('dashboard', () => {
  it('range bounds are India calendar days', () => {
    const now = new Date('2026-10-09T20:00:00Z');                                // 01:30 on 10 Oct in India
    expect(rangeBounds('today', now)).toMatchObject({ from: new Date('2026-10-09T18:30:00Z'), to: new Date('2026-10-10T18:30:00Z'), bucket: 'hour' });
    expect(rangeBounds('7d', now)).toMatchObject({ from: new Date('2026-10-03T18:30:00Z'), bucket: 'day', days: 7 });
  });

  it('revenue after refunds; cancelled and pending orders left out; series, actions, low stock, top products; STAFF may read', async () => {
    const now = new Date();
    const d = new DashboardService(prisma);
    const before = await d.get('7d', now);
    await placedAt(new Date(now.getTime() - 60_000), { qty: 2 });                          // ₹1,000
    await placedAt(new Date(now.getTime() - 120_000), { refunded: 20_000 });              // ₹500 − ₹200
    await placedAt(new Date(now.getTime() - 180_000), { status: 'CANCELLED' });
    await placedAt(new Date(now.getTime() - 240_000), { status: 'PENDING_PAYMENT' });
    await placedAt(new Date(now.getTime() - 40 * 86_400_000));                             // outside 7 days
    const after = await d.get('7d', now);
    expect(after.revenue - before.revenue).toBe(130_000);
    expect(after.orders - before.orders).toBe(2);
    expect(after.salesSeries).toHaveLength(7);
    expect(after.salesSeries.reduce((s, p) => s + p.revenue, 0)).toBe(after.revenue);
    expect(after.ordersByStatus.CANCELLED ?? 0).toBeGreaterThanOrEqual(1);
    expect(after.topProducts[0]).toMatchObject({ productId, units: expect.any(Number) });
    const today = await d.get('today', now);
    expect(today.salesSeries.map((p) => p.label).slice(0, 2)).toEqual(['00:00', '01:00']);
    const low = await liveProduct(prisma, { variants: [{ price: 20_000, onHand: 2, lowStock: 5 }] });
    const api = await get('/dashboard?range=30d', STAFF);
    expect(api.status).toBe(200);
    expect(api.body).toMatchObject({ range: '30d', pendingActions: { toConfirm: expect.any(Number), messages: null } });
    expect(api.body.lowStock).toContainEqual(expect.objectContaining({ variantId: low.variantIds[0], available: 2, threshold: 5 }));
    expect((await get('/dashboard?range=1y')).status).toBe(400);
  });
});

describe('customers', () => {
  async function customer(o: { email?: string; phone?: string } = {}) {
    const email = o.email ?? `c${uniq()}@example.com`;
    const u = await prisma.user.create({ data: { email, name: 'Hema Rajan', phone: o.phone ?? '+919847012345', role: 'CUSTOMER', status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword('customer-password-1') } });
    return { ...u, password: 'customer-password-1' };
  }
  it('search by email, name or phone digits; STAFF sees masked contact; staff accounts are not customers', async () => {
    const c = await customer({ phone: '+919812345678' });
    await placedAt(new Date(), { userId: c.id, qty: 2 });
    const byEmail = await get(`/customers?q=${encodeURIComponent(c.email)}`);
    expect(byEmail.body.data).toEqual([expect.objectContaining({ id: c.id, email: c.email, phone: '+919812345678', orders: 1, spent: 100_000, status: 'ACTIVE' })]);
    expect((await get('/customers?q=12345678')).body.data.map((r: { id: number }) => r.id)).toContain(c.id);
    const masked = (await get(`/customers?q=${encodeURIComponent(c.email)}`, STAFF)).body.data[0];
    expect([masked.email, masked.phone]).toEqual([`${c.email[0]}***@example.com`, '+********5678']);
    const detail = (await get(`/customers/${c.id}`, STAFF)).body;
    expect(detail).toMatchObject({ contactMasked: true, recentOrders: [expect.objectContaining({ total: 100_000 })] });
    const staffRow = await prisma.user.findFirstOrThrow({ where: { role: 'STAFF' } });
    expect((await get(`/customers/${staffRow.id}`)).status).toBe(404);
    expect((await get('/customers?q=x'.padEnd(120, 'x'))).status).toBe(400);
  });

  it('staff note: limit at 2,000; STAFF cannot edit; audited', async () => {
    const c = await customer();
    expect((await send('patch', `/customers/${c.id}`, { adminNotes: 'x' }, STAFF)).status).toBe(403);
    expect(fields(await send('patch', `/customers/${c.id}`, { adminNotes: 'x'.repeat(2001) }))).toEqual({ adminNotes: 'Use at most 2,000 characters' });
    expect((await send('patch', `/customers/${c.id}`, { adminNotes: 'x'.repeat(2000) })).body.adminNotes).toHaveLength(2000);
    expect((await send('patch', `/customers/${c.id}`, { adminNotes: '  ' })).body.adminNotes).toBeNull();
    expect(missingAudit).toEqual([]);
  });

  it('block (with a reason) ends sessions and refuses login; twice → 422; unblock restores; audited', async () => {
    const c = await customer();
    const login = () => request(app).post('/v1/auth/login').set('Origin', WEB).send({ email: c.email, password: c.password });
    expect((await login()).status).toBe(200);
    expect(fields(await send('post', `/customers/${c.id}/block`, {}))).toEqual({ reason: 'Say why you are blocking this customer' });
    const b = await send('post', `/customers/${c.id}/block`, { reason: 'Repeated chargebacks' });
    expect(b.body.status).toBe('BLOCKED');
    expect(await prisma.session.count({ where: { userId: c.id, revokedAt: null } })).toBe(0);
    expect((await login()).body.error.code).toBe('ACCOUNT_BLOCKED');
    expect((await send('post', `/customers/${c.id}/block`, { reason: 'again please' })).body.error.code).toBe('INVALID_TRANSITION');
    expect((await send('post', `/customers/${c.id}/unblock`)).body.status).toBe('ACTIVE');
    expect((await login()).status).toBe(200);
    expect((await prisma.auditLog.findMany({ where: { entity: 'user', entityId: String(c.id) }, orderBy: { id: 'asc' } })).map((a) => a.action)).toEqual(['customer.block', 'customer.unblock']);
    expect((await send('post', '/customers/999999/unblock')).status).toBe(404);
  });
});

describe('restock requests', () => {
  async function waiting(n: number, v = variantId, p = productId) {
    for (let i = 0; i < n; i++) await prisma.stockNotification.create({ data: { variantId: v, productId: p, email: `w${uniq()}@example.com` } });
  }
  async function deliveries() {
    return prisma.$queryRaw<{ id: bigint }[]>`SELECT d.id FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id
      WHERE d.consumer = 'restock.notify' AND d.status <> 'COMPLETED' ORDER BY d.id`;
  }
  it('grouped by variant; Notify now only when available and once a day; the consumer emails each customer once', async () => {
    const live = await liveProduct(prisma, { variants: [{ price: 30_000, onHand: 0 }] });
    const [v, p] = [live.variantIds[0]!, live.productId];
    await waiting(3, v, p);
    const list = (await get('/restock-requests', STAFF)).body.data.find((g: { variantId: number }) => g.variantId === v);
    expect(list).toMatchObject({ pending: 3, available: 0, notifiedToday: false });
    expect((await get(`/restock-requests/variants/${v}`, STAFF)).body.data[0].email).toMatch(/^w\*\*\*@example\.com$/);
    expect((await send('post', '/restock-requests/notify', { variantId: v }, STAFF)).status).toBe(403);
    expect((await send('post', '/restock-requests/notify', { variantId: v })).body.error.code).toBe('NOT_AVAILABLE');

    await prisma.productVariant.update({ where: { id: v }, data: { onHand: 5 } });
    const r = await send('post', '/restock-requests/notify', { variantId: v });
    expect(r.body).toEqual({ queued: true, pending: 3 });
    expect((await send('post', '/restock-requests/notify', { variantId: v })).body).toEqual({ queued: false, pending: 3 });
    expect((await get('/restock-requests?available=1')).body.data.find((g: { variantId: number }) => g.variantId === v).notifiedToday).toBe(true);
    const ds = await deliveries();
    expect(ds).toHaveLength(1);
    expect(await processRestockNotify({ prisma, log }, Number(ds[0]!.id))).toBe('NOTIFIED');
    expect(await processRestockNotify({ prisma, log }, Number(ds[0]!.id))).toBe('ALREADY_DONE');
    expect(await prisma.stockNotification.count({ where: { variantId: v, status: 'NOTIFIED' } })).toBe(3);
    const mails = await prisma.$queryRaw<{ id: bigint }[]>`SELECT d.id FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id WHERE e.event_type = 'restock.email' AND e.payload->>'sku' = (SELECT sku FROM product_variants WHERE id = ${v})`;
    expect(mails).toHaveLength(3);
    const mail = new MemoryTransport();
    await processEmailDelivery({ prisma, transport: mail, from: 'x@artq.in', log, links: { webUrl: WEB, linkSecret: 's', setPasswordTtlS: 60 } }, 'email.customer', Number(mails[0]!.id));
    expect(mail.sent[0]!.subject).toMatch(/is back in stock$/);
    expect(mail.sent[0]!.text).toMatch(/http:\/\/localhost:3000\/product\/[^?]+\?variant=/);
    expect((await send('post', '/restock-requests/notify', { variantId: v })).body.error.code).toBe('NOTHING_TO_NOTIFY');
    expect(missingAudit).toEqual([]);
  });

  it('a back-in-stock event while the size sold out again keeps the requests waiting; cancel one request', async () => {
    await waiting(2);
    await prisma.productVariant.update({ where: { id: variantId }, data: { onHand: 0, reserved: 0 } });
    const { emit } = await import('../../src/db/functions.js');
    await emit(prisma, { aggregateType: 'variant', aggregateId: String(variantId), type: 'variant.back_in_stock', payload: { variant_id: variantId }, consumers: ['restock.notify'] });
    const ds = await deliveries();
    expect(await processRestockNotify({ prisma, log }, Number(ds.at(-1)!.id))).toBe('NOT_AVAILABLE');
    expect(await prisma.stockNotification.count({ where: { variantId, status: 'PENDING' } })).toBeGreaterThanOrEqual(2);
    const one = await prisma.stockNotification.findFirstOrThrow({ where: { variantId, status: 'PENDING' } });
    expect((await send('delete', `/restock-requests/${one.id}`)).status).toBe(204);
    expect((await send('delete', `/restock-requests/${one.id}`)).body.error.code).toBe('INVALID_TRANSITION');
    expect((await send('delete', '/restock-requests/999999')).status).toBe(404);
    await prisma.productVariant.update({ where: { id: variantId }, data: { onHand: 100 } });
  });
});
