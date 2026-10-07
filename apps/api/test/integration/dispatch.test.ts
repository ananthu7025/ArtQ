// Task 5.2: Ship through the admin API on real PostgreSQL + Redis. aq_dispatch_order with the invoice computed by the
// shared tax rules: stock consumed once, invoice numbered consecutively (also under 20 concurrent shipments) and stored
// immutably (CGST+SGST in Kerala, IGST elsewhere, shipping and COD fee lines), shipment and history recorded, the
// "shipped" email; refusals on their fields; the invoice PDF rendered once by the outbox consumer and served by link.
import type { PrismaClient, UserRole } from '@prisma/client';
import { financialYear } from '@artq/shared';
import type { Express } from 'express';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdminRouter } from '../../src/admin/router.js';
import { createApp } from '../../src/app.js';
import { adminAuthRouter } from '../../src/auth/admin-routes.js';
import { AuthService, DEFAULT_AUTH_TIMINGS } from '../../src/auth/service.js';
import { RedisSessionCache } from '../../src/auth/session-cache.js';
import * as fn from '../../src/db/functions.js';
import { processEmailDelivery } from '../../src/email/consumer.js';
import { MemoryTransport } from '../../src/email/transport.js';
import { hashPassword } from '../../src/lib/password.js';
import type { RateLimiter } from '../../src/middleware/rateLimit.js';
import { registerOrderRoutes } from '../../src/orders/admin-routes.js';
import { DispatchService, processInvoiceRender } from '../../src/orders/dispatch.js';
import { seedGeo, seedSettings, seedShipping } from '../../src/seed/steps.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { catalog, order, tx, uniq } from '../helpers/fixtures.js';
import { MemoryObjectStore } from '../helpers/memory-store.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const ORIGIN = 'http://localhost:5173';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const NO_LIMIT: RateLimiter = { hit: async () => ({ count: 0, resetMs: 60_000 }) };
const log = pino({ level: 'silent' });
const FY = financialYear(new Date());
let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express, store: MemoryObjectStore, dispatch: DispatchService;
let v1: number, v2: number, ADMIN: { token: string }, STAFF: { token: string };
const missingAudit: string[] = [];

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  await seedShipping(prisma); await seedGeo(prisma); await seedSettings(prisma);
  [v1, v2] = (await tx(prisma, (t) => catalog(t, [[{ price: 47_400, onHand: 500 }], [{ price: 10_000, onHand: 500 }]]))).products.map((p) => p.variantIds[0]!) as [number, number];
  store = new MemoryObjectStore();
  dispatch = new DispatchService(prisma, { store, buckets: { PUBLIC: 'pub', PRIVATE: 'priv' } });
  const cache = new RedisSessionCache(redis);
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: 'http://localhost:3000', adminUrl: ORIGIN });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log, hasRecentStepUp: (sid) => service.hasRecentStepUp(sid), onMissingAudit: (req) => missingAudit.push(`${req.method} ${req.originalUrl}`) });
  registerOrderRoutes(admin, prisma, dispatch);
  app = createApp({ version: 't', origins: { storefront: ['http://localhost:3000'], admin: [ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} }, routes: [adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }), admin.router] });
  [ADMIN, STAFF] = [await login('ADMIN'), await login('STAFF')];
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });

async function login(role: UserRole) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  await prisma.user.create({ data: { email, name: role, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword('dispatch-password-1') } });
  return { token: (await request(app).post('/v1/admin/auth/login').set('Origin', ORIGIN).send({ email, password: 'dispatch-password-1' })).body.accessToken as string };
}
const call = (method: 'get' | 'post', path: string, body?: object, who = ADMIN) => {
  const r = request(app)[method](`/v1/admin${path}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${who.token}`);
  return body ? r.send(body) : r;
};
const fields = (res: request.Response) => Object.fromEntries((res.body.error?.details ?? []).map((d: { path: string; message: string }) => [d.path, d.message]));

/** A COD order (2 × ₹474 + 1 × ₹100, shipping ₹70, COD ₹40) confirmed and packed, delivering to `stateCode`. */
async function packed(stateCode = '32', state = 'Kerala') {
  const f = await tx(prisma, (t) => order(t, { lines: [{ variantId: v1, qty: 2 }, { variantId: v2, qty: 1 }], method: 'COD', shippingFee: 7000, codFee: 4000 }));
  await prisma.order.update({ where: { id: f.orderId }, data: { paymentStatus: 'UNPAID', shipStateCode: stateCode, shipState: state, shipName: 'Hema Rajan', contactEmail: `b${uniq()}@example.com` } });
  await tx(prisma, (t) => fn.placeCodOrder(t, f.orderId, 'CUSTOMER'));
  await call('post', `/orders/${f.orderId}/confirm`, { notifyCustomer: false });
  await call('post', `/orders/${f.orderId}/pack`, {});
  return f;
}
const ship = (id: number, o: object = {}, who = ADMIN) => call('post', `/orders/${id}/ship`, { courierName: 'DTDC', awbNumber: `D${uniq()}`.toUpperCase().slice(0, 30), trackingUrl: 'https://track.test/x', weightG: 1400, ...o }, who);
const stock = (v: number) => prisma.productVariant.findUniqueOrThrow({ where: { id: v }, select: { onHand: true, reserved: true } });

describe('ship', () => {
  it('consumes the stock, issues the invoice (Kerala: CGST+SGST; shipping and COD fee lines), records the shipment; STAFF may ship', async () => {
    const o = await packed();
    const [s1, s2] = [await stock(v1), await stock(v2)];
    const res = await ship(o.orderId, { awbNumber: 'dtdc-0001', notifyCustomer: true }, STAFF);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ fulfilmentStatus: 'SHIPPED', shipment: { courierName: 'DTDC', awbNumber: 'DTDC-0001', trackingUrl: 'https://track.test/x', weightG: 1400, status: 'SHIPPED' },
      invoices: [{ kind: 'TAX_INVOICE', number: expect.stringMatching(new RegExp(`^AQ/${FY}/\\d{6}$`)), grandTotal: o.total }], actions: ['out-for-delivery', 'deliver'] });
    expect(res.body.history.at(-1)).toMatchObject({ dimension: 'FULFILMENT', from: 'PACKED', to: 'SHIPPED', actor: 'ADMIN' });
    expect(await stock(v1)).toEqual({ onHand: s1.onHand - 2, reserved: s1.reserved - 2 });
    expect(await stock(v2)).toEqual({ onHand: s2.onHand - 1, reserved: s2.reserved - 1 });
    expect(await prisma.inventoryReservation.count({ where: { orderId: o.orderId, status: 'CONSUMED' } })).toBe(2);
    const inv = await prisma.invoice.findFirstOrThrow({ where: { orderId: o.orderId } });
    expect(inv).toMatchObject({ placeOfSupply: '32', igstTotal: 0, roundingAdjustment: 0, grandTotal: o.total });
    expect(inv.taxableTotal + inv.cgstTotal + inv.sgstTotal).toBe(o.total);
    expect((inv.lines as { kind: string; ratePercent: number }[]).map((l) => `${l.kind}@${l.ratePercent}`)).toEqual(['ITEM@18', 'ITEM@18', 'SHIPPING@18', 'COD_FEE@18']);
    expect(inv.sellerSnapshot).toMatchObject({ stateCode: '32' });
    expect(inv.buyerSnapshot).toMatchObject({ name: 'Hema Rajan', stateCode: '32', state: 'Kerala' });
    expect(await prisma.auditLog.count({ where: { action: 'order.ship', entityId: String(o.orderId) } })).toBe(1);
    expect(missingAudit).toEqual([]);

    // The customer email names the courier and AWB.
    const mail = new MemoryTransport();
    const [d] = await prisma.$queryRaw<{ id: bigint }[]>`SELECT d.id FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id WHERE e.aggregate_id = ${o.orderNumber} AND e.event_type = 'order.status_changed' AND e.payload->>'to' = 'SHIPPED'`;
    await processEmailDelivery({ prisma, transport: mail, from: 'ArtQ <x@artq.in>', log }, 'email.customer', Number(d!.id));
    expect(mail.sent[0]).toMatchObject({ subject: `Order ${o.orderNumber} shipped`, text: expect.stringContaining('on its way with DTDC. Tracking number: DTDC-0001.') });
  });

  it('outside Kerala the invoice is IGST only, place of supply the delivery state; no email when not notifying', async () => {
    const o = await packed('29', 'Karnataka');
    expect((await ship(o.orderId, { notifyCustomer: false })).status).toBe(200);
    const inv = await prisma.invoice.findFirstOrThrow({ where: { orderId: o.orderId } });
    expect(inv).toMatchObject({ placeOfSupply: '29', cgstTotal: 0, sgstTotal: 0 });
    expect(inv.taxableTotal + inv.igstTotal).toBe(o.total);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: o.orderNumber, eventType: 'order.status_changed', payload: { path: ['to'], equals: 'SHIPPED' } } })).toBe(0);
  });

  it('refusals: not packed (422 saying where it is), an AWB this courier already used (on its field; another courier may), bad input on its fields', async () => {
    const o = await packed();
    const first = await ship(o.orderId, { awbNumber: 'SAME-AWB-1' });
    expect(first.status).toBe(200);
    const again = await ship(o.orderId, { awbNumber: 'OTHER-1' });
    expect(again.body.error).toMatchObject({ code: 'INVALID_TRANSITION', message: 'This order can’t be shipped now: it is confirmed, shipped, cash on delivery. Reload to see its latest state.' });
    const other = await packed();
    expect(fields(await ship(other.orderId, { awbNumber: 'same-awb-1' }))).toEqual({ awbNumber: 'This AWB number is already used for another DTDC shipment' });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: other.orderId } })).fulfilmentStatus).toBe('PACKED');
    expect((await ship(other.orderId, { courierName: 'Delhivery', awbNumber: 'SAME-AWB-1' })).status).toBe(200);
    const third = await packed();
    expect(fields(await call('post', `/orders/${third.orderId}/ship`, {}))).toEqual({ courierName: 'Enter the courier', awbNumber: 'Enter the AWB / tracking number' });
    expect(fields(await ship(third.orderId, { trackingUrl: 'javascript:alert(1)', weightG: 0 }))).toEqual({ trackingUrl: 'Enter a full https:// link', weightG: 'Use at least 1 g' });
    expect((await call('post', '/orders/999999/ship', { courierName: 'DTDC', awbNumber: 'X1234' })).status).toBe(404);
  });

  it('20 orders shipped at once: consecutive invoice numbers, no gaps; one order pressed 5 times ships once', async () => {
    const orders = await Promise.all(Array.from({ length: 20 }, () => packed()));
    const last = (await prisma.invoiceCounter.findUnique({ where: { kind_fy: { kind: 'TAX_INVOICE', fy: FY } } }))?.lastNo ?? 0;
    const res = await Promise.all(orders.map((o) => ship(o.orderId)));
    expect(res.map((r) => r.status)).toEqual(Array(20).fill(200));
    const seqs = (await prisma.invoice.findMany({ where: { orderId: { in: orders.map((o) => o.orderId) } }, select: { seq: true } })).map((i) => i.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => last + i + 1));

    const one = await packed();
    const v = await stock(v1);
    const race = await Promise.all(Array.from({ length: 5 }, (_, i) => ship(one.orderId, { awbNumber: `RACE-${i}-${uniq()}`.slice(0, 40) })));
    expect(race.map((r) => r.status).sort()).toEqual([200, 422, 422, 422, 422]);
    expect((await stock(v1)).onHand).toBe(v.onHand - 2);
    expect(await prisma.invoice.count({ where: { orderId: one.orderId } })).toBe(1);
  });
});

describe('invoice PDF', () => {
  it('no invoice before shipping (404 with the reason); after shipping the consumer renders it once; the link is short-lived and private', async () => {
    const o = await packed();
    const before = await call('get', `/orders/${o.orderId}/invoice`);
    expect(before.status).toBe(404);
    expect(before.body.error.message).toBe('This order has no invoice yet. It is issued when the order ships.');
    await ship(o.orderId);
    const inv = await prisma.invoice.findFirstOrThrow({ where: { orderId: o.orderId } });
    const [d] = await prisma.$queryRaw<{ id: bigint }[]>`SELECT d.id FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id WHERE e.event_type = 'invoice.render' AND e.payload->>'invoice_id' = ${String(inv.id)}`;
    expect(await processInvoiceRender({ prisma, dispatch, log }, Number(d!.id))).toBe('DONE');
    expect(await processInvoiceRender({ prisma, dispatch, log }, Number(d!.id))).toBe('ALREADY_DONE');
    const withPdf = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: { pdf: true } });
    expect(withPdf.pdf).toMatchObject({ visibility: 'PRIVATE', kind: 'DOCUMENT', status: 'READY', ownerScope: `invoice:${o.orderId}`, declaredMime: 'application/pdf' });
    const pdf = store.objects.get(`priv/${withPdf.pdf!.key}`)!;
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
    const link = await call('get', `/orders/${o.orderId}/invoice`, undefined, STAFF);
    expect(link.body).toEqual({ number: inv.number, url: `https://storage.test/priv/${withPdf.pdf!.key}?exp=300&download=${encodeURIComponent(`invoice-${inv.number.replace(/\//g, '-')}.pdf`)}` });
    await expect(prisma.invoice.update({ where: { id: inv.id }, data: { pdfMediaId: null } })).rejects.toThrow(/immutable/);
  });

  it('asked for before the worker ran: rendered on request; three at once store one PDF', async () => {
    const o = await packed();
    await ship(o.orderId);
    const inv = await prisma.invoice.findFirstOrThrow({ where: { orderId: o.orderId } });
    const ids = await Promise.all([dispatch.ensurePdf(inv.id), dispatch.ensurePdf(inv.id), dispatch.ensurePdf(inv.id)]);
    expect(new Set(ids).size).toBe(1);
    expect(await prisma.media.count({ where: { ownerScope: `invoice:${o.orderId}`, deletedAt: null } })).toBe(1);
    expect((await call('get', `/orders/${o.orderId}/invoice`)).body.number).toBe(inv.number);
  });
});
