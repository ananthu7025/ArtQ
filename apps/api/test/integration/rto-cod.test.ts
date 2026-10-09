// Task 5.6 on real PostgreSQL + Redis through the admin endpoints. RTO: returning → received (every unit inspected,
// sellable restocked, order cancelled, prepaid items refunded without shipping per D-9, COD not collected, email).
// Lost: refund (cancelled, full refund incl. shipping) or reship (kept; COD not collected), a note required. COD
// remittances: the outstanding list and summary, recording a payout (fields checked on the form's paths, a short line
// → mismatch exception, once per order under concurrency, duplicate reference), permissions, audit, the overdue email.
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
import { processEmailDelivery } from '../../src/email/consumer.js';
import { MemoryTransport } from '../../src/email/transport.js';
import { hashPassword } from '../../src/lib/password.js';
import type { RateLimiter } from '../../src/middleware/rateLimit.js';
import { registerOrderRoutes } from '../../src/orders/admin-routes.js';
import { codOverdueCheck, registerCodRoutes } from '../../src/orders/cod.js';
import { DispatchService } from '../../src/orders/dispatch.js';
import { seedGeo, seedSettings, seedShipping } from '../../src/seed/steps.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { attempt, capture, catalog, order, tx, uniq } from '../helpers/fixtures.js';
import { MemoryObjectStore } from '../helpers/memory-store.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const ORIGIN = 'http://localhost:5173';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const NO_LIMIT: RateLimiter = { hit: async () => ({ count: 0, resetMs: 60_000 }) };
const log = pino({ level: 'silent' });
let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express, variantId: number;
let ADMIN: { token: string }, STAFF: { token: string };
const missingAudit: string[] = [];

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  await seedShipping(prisma); await seedGeo(prisma); await seedSettings(prisma);
  const notify = { adminEmails: ['owner@artq.in'], dailySummary: true, lowStockEmail: true };
  await prisma.setting.upsert({ where: { key: 'NOTIFY' }, update: { value: notify }, create: { key: 'NOTIFY', value: notify } });
  variantId = (await tx(prisma, (t) => catalog(t, [[{ price: 50_000, onHand: 1000 }]]))).products[0]!.variantIds[0]!;
  const cache = new RedisSessionCache(redis);
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: 'http://localhost:3000', adminUrl: ORIGIN });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log, hasRecentStepUp: async () => true, onMissingAudit: (req) => missingAudit.push(`${req.method} ${req.originalUrl}`) });
  registerOrderRoutes(admin, prisma, new DispatchService(prisma, { store: new MemoryObjectStore(), buckets: { PUBLIC: 'p', PRIVATE: 'q' } }));
  registerCodRoutes(admin, prisma);
  app = createApp({ version: 't', origins: { storefront: ['http://localhost:3000'], admin: [ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} }, routes: [adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }), admin.router] });
  [ADMIN, STAFF] = [await staff('ADMIN'), await staff('STAFF')];
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });
beforeEach(() => { missingAudit.length = 0; });

async function staff(role: UserRole) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  await prisma.user.create({ data: { email, name: role, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword('rto-password-1') } });
  return { token: (await request(app).post('/v1/admin/auth/login').set('Origin', ORIGIN).send({ email, password: 'rto-password-1' })).body.accessToken as string };
}
const get = (path: string, who = ADMIN) => request(app).get(`/v1/admin${path}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${who.token}`);
const post = (path: string, body: object = {}, who = ADMIN) => request(app).post(`/v1/admin${path}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${who.token}`).send(body);
const fields = (res: request.Response) => Object.fromEntries((res.body.error?.details ?? []).map((d: { path: string; message: string }) => [d.path, d.message]));
const onHand = async () => (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).onHand;

/** 3 × ₹500 + shipping ₹70 (+ COD fee ₹40), shipped (stock consumed); prepaid (captured) or COD. */
async function shipped(method: 'RAZORPAY' | 'COD' = 'RAZORPAY', fulfilment: 'SHIPPED' | 'DELIVERED' = 'SHIPPED', deliveredDaysAgo = 1) {
  const made = await tx(prisma, (t) => order(t, { lines: [{ variantId, qty: 3 }], method, shippingFee: 7000, codFee: method === 'COD' ? 4000 : 0 }));
  const f = { ...made, orderNumber: made.orderNumber.toUpperCase() };           // real order numbers are AQ + digits; staff type them
  await prisma.order.update({ where: { id: f.orderId }, data: { paymentStatus: 'UNPAID', orderNumber: f.orderNumber } });
  if (method === 'COD') await tx(prisma, (t) => fn.placeCodOrder(t, f.orderId, 'CUSTOMER'));
  else {
    const a = await tx(prisma, (t) => attempt(t, f.orderId, f.total));
    await tx(prisma, (t) => capture(t, { providerOrderId: a.providerOrderId, paymentId: `pay_${uniq()}`, amount: f.total }));
  }
  await prisma.inventoryReservation.updateMany({ where: { orderId: f.orderId }, data: { status: 'CONSUMED', consumedAt: new Date() } });
  await prisma.$executeRaw`UPDATE product_variants SET reserved = reserved - 3, on_hand = on_hand - 3 WHERE id = ${variantId}`;
  const cod = method === 'COD' && fulfilment === 'DELIVERED';
  await prisma.order.update({ where: { id: f.orderId }, data: { status: 'CONFIRMED', fulfilmentStatus: fulfilment, ...(cod ? { paymentStatus: 'COD_COLLECTED' } : {}) } });
  await prisma.shipment.create({ data: { orderId: f.orderId, courierName: 'DTDC', awbNumber: `C${uniq()}`, status: fulfilment, shippedAt: new Date(Date.now() - (deliveredDaysAgo + 2) * 86_400_000),
    deliveredAt: fulfilment === 'DELIVERED' ? new Date(Date.now() - deliveredDaysAgo * 86_400_000) : null } });
  return { ...f, item: f.items[0]!.orderItemId };
}
async function customerEmails(orderNumber: string, type: string) {
  const mail = new MemoryTransport();
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`SELECT d.id FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id
    WHERE e.aggregate_id = ${orderNumber} AND e.event_type = ${type} AND d.consumer = 'email.customer' ORDER BY d.id`;
  for (const r of rows) await processEmailDelivery({ prisma, transport: mail, from: 'x@artq.in', log }, 'email.customer', Number(r.id));
  return mail.sent;
}

describe('RTO', () => {
  it('prepaid: returning → received; sellable restocked, order cancelled, items refunded without shipping (D-9); emailed; audited', async () => {
    const o = await shipped();
    expect((await get(`/orders/${o.orderId}`)).body.actions).toEqual(['out-for-delivery', 'deliver', 'rto', 'lost']);
    const r1 = await post(`/orders/${o.orderId}/rto`, {}, STAFF);
    expect([r1.status, r1.body.fulfilmentStatus, r1.body.actions]).toEqual([200, 'RTO_IN_TRANSIT', ['rto-received', 'lost']]);
    expect(r1.body.shipment.status).toBe('RTO_IN_TRANSIT');
    expect((await post(`/orders/${o.orderId}/rto`)).body.error.code).toBe('INVALID_TRANSITION');

    expect(fields(await post(`/orders/${o.orderId}/rto-received`, {}))).toHaveProperty('items');
    expect(fields(await post(`/orders/${o.orderId}/rto-received`, { items: [{ orderItemId: o.item, sellableQty: 2, damagedQty: 0 }] }))).toEqual({ 'items.0.sellableQty': 'Sellable and damaged units must add up to the units in the order' });
    const before = await onHand();
    const res = await post(`/orders/${o.orderId}/rto-received`, { items: [{ orderItemId: o.item, sellableQty: 2, damagedQty: 1 }] }, STAFF);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'CANCELLED', fulfilmentStatus: 'RTO_RECEIVED', paymentStatus: 'PAID', actions: [], refunds: [{ kind: 'CANCELLATION', status: 'REQUESTED', amount: 150_000 }] });
    expect(res.body.history.find((h: { to: string }) => h.to === 'RTO_RECEIVED').note).toBe('1 damaged unit(s) not restocked');
    expect(await onHand()).toBe(before + 2);
    expect((await post(`/orders/${o.orderId}/rto-received`, { items: [{ orderItemId: o.item, sellableQty: 3, damagedQty: 0 }] })).body.error.code).toBe('INVALID_TRANSITION');
    const [mail] = await customerEmails(o.orderNumber, 'order.cancelled');
    expect(mail!.subject).toBe(`Order ${o.orderNumber} returned to us and cancelled`);
    expect(mail!.text).toContain('₹1,500 for the items is being refunded to your original payment method (the shipping charge isn’t refunded)');
    expect((await prisma.auditLog.findMany({ where: { entity: 'order', entityId: String(o.orderId) }, orderBy: { id: 'asc' } })).map((a) => a.action)).toEqual(['order.rto', 'order.rto_received']);
    expect(missingAudit).toEqual([]);
  });

  it('COD: received → cancelled, cash not collected, no refund; the quiet option sends no email', async () => {
    const o = await shipped('COD');
    await post(`/orders/${o.orderId}/rto`);
    const res = await post(`/orders/${o.orderId}/rto-received`, { items: [{ orderItemId: o.item, sellableQty: 3, damagedQty: 0 }], notifyCustomer: false });
    expect([res.body.status, res.body.paymentStatus, res.body.refunds]).toEqual(['CANCELLED', 'NOT_COLLECTED', []]);
    expect(await customerEmails(o.orderNumber, 'order.cancelled')).toEqual([]);
  });

  it('not shipped / delivered orders cannot go RTO; unknown order 404', async () => {
    const d = await shipped('RAZORPAY', 'DELIVERED');
    expect((await post(`/orders/${d.orderId}/rto`)).body.error.message).toMatch(/^This order can’t be marked as returning to us now: it is confirmed, delivered, paid/);
    expect((await post(`/orders/${d.orderId}/rto-received`, { items: [{ orderItemId: d.item, sellableQty: 3, damagedQty: 0 }] })).body.error.code).toBe('INVALID_TRANSITION');
    expect((await post('/orders/999999/rto-received', { items: [{ orderItemId: 1, sellableQty: 1, damagedQty: 0 }] })).status).toBe(404);
  });
});

describe('lost', () => {
  it('refund: cancelled with a full refund incl. shipping, no stock change, write-off recorded; the customer is told', async () => {
    const o = await shipped();
    expect(fields(await post(`/orders/${o.orderId}/lost`, { resolution: 'REFUND' }))).toEqual({ note: 'Note the courier’s claim or reference' });
    const before = await onHand();
    const res = await post(`/orders/${o.orderId}/lost`, { resolution: 'REFUND', note: 'DTDC claim 4471' }, STAFF);
    expect(res.body).toMatchObject({ status: 'CANCELLED', fulfilmentStatus: 'LOST', refunds: [{ kind: 'CANCELLATION', amount: o.total }] });
    expect(await onHand()).toBe(before);
    expect(await prisma.inventoryMovement.count({ where: { orderId: o.orderId, reason: 'LOST_WRITE_OFF', onHandDelta: 0 } })).toBe(1);
    const [mail] = await customerEmails(o.orderNumber, 'order.lost');
    expect(mail!.text).toContain(`We’re sorry: the courier has lost the parcel for your order ${o.orderNumber}. We’ve cancelled the order and ₹1,570 is being refunded`);
    expect((await post(`/orders/${o.orderId}/lost`, { resolution: 'REFUND', note: 'again' })).body.error.code).toBe('INVALID_TRANSITION');
  });

  it('reship (COD, while returning): order kept, cash not collected, no refund; the email promises a replacement', async () => {
    const o = await shipped('COD');
    await post(`/orders/${o.orderId}/rto`);
    const res = await post(`/orders/${o.orderId}/lost`, { resolution: 'RESHIP', note: 'Lost on the way back' });
    expect([res.body.status, res.body.fulfilmentStatus, res.body.paymentStatus, res.body.refunds, res.body.actions]).toEqual(['CONFIRMED', 'LOST', 'NOT_COLLECTED', [], []]);
    expect((await customerEmails(o.orderNumber, 'order.lost'))[0]!.text).toContain('We’re sending you a replacement');
  });
});

describe('COD remittances', () => {
  it('outstanding list (oldest first, overdue after 14 days) and summary; staff without cod:remit get 403', async () => {
    const old = await shipped('COD', 'DELIVERED', 20), fresh = await shipped('COD', 'DELIVERED', 2);
    const res = await get('/cod/outstanding?limit=500');
    const mine = res.body.data.filter((r: { orderId: number }) => [old.orderId, fresh.orderId].includes(r.orderId));
    expect(mine.map((r: { orderId: number; days: number; overdue: boolean }) => [r.orderId, r.days, r.overdue])).toEqual([[old.orderId, 20, true], [fresh.orderId, 2, false]]);
    expect(res.body.summary.overdueCount).toBeGreaterThanOrEqual(1);
    expect((await get('/cod/outstanding?overdue=1&limit=500')).body.data.some((r: { orderId: number }) => r.orderId === fresh.orderId)).toBe(false);
    expect((await get('/cod/outstanding', STAFF)).status).toBe(403);
    expect((await post('/cod-remittances', {}, STAFF)).status).toBe(403);
  });

  it('record a payout: fields checked; a short line → mismatch + exception; remitted orders leave the list; duplicate reference refused; audited', async () => {
    const a = await shipped('COD', 'DELIVERED'), b = await shipped('COD', 'DELIVERED'), paid = await shipped('RAZORPAY', 'DELIVERED');
    const ref = `UTR${uniq()}`;
    const body = { courierName: 'DTDC', reference: ref, remittedAt: '2026-10-05', amount: a.total + b.total - 4000, orders: [{ orderNumber: a.orderNumber, amount: a.total }, { orderNumber: b.orderNumber, amount: b.total - 4000 }] };
    expect(Object.keys(fields(await post('/cod-remittances', {})))).toEqual(expect.arrayContaining(['courierName', 'reference', 'remittedAt', 'amount', 'orders']));
    expect(fields(await post('/cod-remittances', { ...body, amount: body.amount + 1 }))).toEqual({ amount: `The orders add up to ₹${((body.amount) / 100).toLocaleString('en-IN')}` });
    expect(fields(await post('/cod-remittances', { ...body, remittedAt: '2999-01-01' }))).toEqual({ remittedAt: 'The payout date can’t be in the future' });
    expect(fields(await post('/cod-remittances', { ...body, orders: [...body.orders.slice(0, 1), { orderNumber: 'AQ0000000', amount: b.total - 4000 }] }))).toEqual({ 'orders.1.orderNumber': 'No order with this number' });
    expect(fields(await post('/cod-remittances', { ...body, amount: a.total + paid.total, orders: [body.orders[0], { orderNumber: paid.orderNumber, amount: paid.total }] }))['orders.1.orderNumber']).toMatch(/^Not a delivered cash-on-delivery order/);
    expect(await prisma.codRemittance.count({ where: { reference: ref } })).toBe(0);

    const res = await post('/cod-remittances', body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.mismatches).toEqual([{ orderNumber: b.orderNumber, expected: b.total, remitted: b.total - 4000 }]);
    expect(res.body.remittance).toMatchObject({ courierName: 'DTDC', reference: ref, amount: body.amount, remittedAt: '2026-10-04T18:30:00.000Z', recordedBy: 'ADMIN' });
    expect(await prisma.paymentException.findFirst({ where: { orderId: b.orderId }, select: { type: true, amount: true } })).toEqual({ type: 'COD_REMITTANCE_MISMATCH', amount: -4000 });
    expect((await get(`/orders/${a.orderId}`)).body.paymentStatus).toBe('COD_REMITTED');
    const outstanding = (await get('/cod/outstanding?limit=500')).body.data.map((r: { orderId: number }) => r.orderId);
    expect(outstanding).not.toContain(a.orderId);
    const c = await shipped('COD', 'DELIVERED');
    expect(fields(await post('/cod-remittances', { ...body, amount: c.total, orders: [{ orderNumber: c.orderNumber, amount: c.total }] }))).toEqual({ reference: 'This DTDC payout reference is already recorded' });
    expect(fields(await post('/cod-remittances', { ...body, reference: `X${ref}`, amount: a.total, orders: [{ orderNumber: a.orderNumber, amount: a.total }] }))['orders.0.orderNumber']).toMatch(/already remitted/);
    expect((await get('/cod-remittances')).body.data[0]).toMatchObject({ reference: ref, orders: [{ orderNumber: a.orderNumber, amount: a.total, expected: a.total }, { orderNumber: b.orderNumber, amount: b.total - 4000, expected: b.total }] });
    expect(await prisma.auditLog.count({ where: { action: 'cod.remittance.create', entityId: String(res.body.remittance.id) } })).toBe(1);
    expect(missingAudit).toEqual([]);
  });

  it('concurrency: five payouts for the same order at once → exactly one recorded', async () => {
    const o = await shipped('COD', 'DELIVERED');
    const results = await Promise.all(Array.from({ length: 5 }, (_, n) => post('/cod-remittances', { courierName: 'DTDC', reference: `CC${uniq()}-${n}`, remittedAt: '2026-10-05', amount: o.total, orders: [{ orderNumber: o.orderNumber, amount: o.total }] })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 201).every((r) => [400, 409].includes(r.status))).toBe(true);
    expect(await prisma.codRemittanceItem.count({ where: { orderId: o.orderId } })).toBe(1);
  });

  it('overdue job: one staff email a day while cash is overdue', async () => {
    await shipped('COD', 'DELIVERED', 30);
    expect(await codOverdueCheck(prisma)).toBe('NOTIFIED');
    expect(await codOverdueCheck(prisma)).toBe('ALREADY_NOTIFIED');
    const [d] = await prisma.$queryRaw<{ id: bigint }[]>`SELECT d.id FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id WHERE e.event_type = 'cod.remittance_overdue' ORDER BY d.id DESC LIMIT 1`;
    const mail = new MemoryTransport();
    await processEmailDelivery({ prisma, transport: mail, from: 'x@artq.in', log }, 'email.admin', Number(d!.id));
    expect(mail.sent[0]).toMatchObject({ to: 'owner@artq.in', subject: expect.stringMatching(/^\[ArtQ\] COD cash overdue: \d+ order\(s\), ₹/) });
    expect(await codOverdueCheck(prisma, new Date(Date.now() - 365 * 86_400_000))).toBe('NONE');
  });
});
