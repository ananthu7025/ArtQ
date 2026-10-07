// Task 5.1: Admin Orders on real PostgreSQL + Redis. List filters (4 dimensions, method, exceptions, dates, search),
// detail with masked contact for STAFF, the hand transitions (confirm → pack; shipped → out for delivery → delivered,
// COD cash collected), concurrency (one press wins), address correction (checked like checkout, version, only before
// packing), staff note, resending an email, the packing slip PDF, and the customer emails these events produce.
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
import { processEmailDelivery } from '../../src/email/consumer.js';
import { MemoryTransport } from '../../src/email/transport.js';
import { hashPassword } from '../../src/lib/password.js';
import type { RateLimiter } from '../../src/middleware/rateLimit.js';
import { registerOrderRoutes } from '../../src/orders/admin-routes.js';
import { DispatchService } from '../../src/orders/dispatch.js';
import { MemoryObjectStore } from '../helpers/memory-store.js';
import { seedGeo, seedSettings, seedShipping } from '../../src/seed/steps.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { attempt, capture, catalog, order, race, tx, uniq } from '../helpers/fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const ORIGIN = 'http://localhost:5173';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const NO_LIMIT: RateLimiter = { hit: async () => ({ count: 0, resetMs: 60_000 }) };
const log = pino({ level: 'silent' });
let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express, variantId: number, kerala: number, karnataka: number;
let ADMIN: { token: string; id: number }, STAFF: { token: string; id: number };
const missingAudit: string[] = [];

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  await seedShipping(prisma); await seedGeo(prisma); await seedSettings(prisma);
  kerala = (await prisma.state.findFirstOrThrow({ where: { name: 'Kerala' } })).id;
  karnataka = (await prisma.state.findFirstOrThrow({ where: { name: 'Karnataka' } })).id;
  const an = (await prisma.state.findFirstOrThrow({ where: { name: 'Andaman and Nicobar Islands' } })).id;
  await prisma.postalCode.createMany({ data: [
    { pincode: '682011', officeName: 'ERNAKULAM H.O', district: 'ERNAKULAM', stateId: kerala },
    { pincode: '560001', officeName: 'BANGALORE G.P.O', district: 'BENGALURU', stateId: karnataka },
    { pincode: '744101', officeName: 'PORT BLAIR H.O', district: 'SOUTH ANDAMAN', stateId: an },
  ] });
  variantId = (await tx(prisma, (t) => catalog(t, [[{ price: 50_000, onHand: 500 }]]))).products[0]!.variantIds[0]!;
  const cache = new RedisSessionCache(redis);
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: 'http://localhost:3000', adminUrl: ORIGIN });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log, hasRecentStepUp: (sid) => service.hasRecentStepUp(sid), onMissingAudit: (req) => missingAudit.push(`${req.method} ${req.originalUrl}`) });
  registerOrderRoutes(admin, prisma, new DispatchService(prisma, { store: new MemoryObjectStore(), buckets: { PUBLIC: 'pub', PRIVATE: 'priv' } }));
  app = createApp({ version: 't', origins: { storefront: ['http://localhost:3000'], admin: [ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} }, routes: [adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }), admin.router] });
  [ADMIN, STAFF] = [await login('ADMIN'), await login('STAFF')];
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });
beforeEach(() => { missingAudit.length = 0; });

async function login(role: UserRole) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  const u = await prisma.user.create({ data: { email, name: `${role} person`, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword('orders-password-1') } });
  return { id: u.id, token: (await request(app).post('/v1/admin/auth/login').set('Origin', ORIGIN).send({ email, password: 'orders-password-1' })).body.accessToken as string };
}
const call = (method: 'get' | 'post' | 'patch', path: string, body?: object, who: { token: string } | null = ADMIN) => {
  let r = request(app)[method](`/v1/admin${path}`).set('Origin', ORIGIN);
  if (who) r = r.set('Authorization', `Bearer ${who.token}`);
  return body ? r.send(body) : r;
};
const fields = (res: request.Response) => Object.fromEntries((res.body.error?.details ?? []).map((d: { path: string; message: string }) => [d.path, d.message]));

/** A placed order: COD through aq_place_cod_order, online through a captured payment. */
async function placed(method: 'COD' | 'RAZORPAY' = 'COD', o: { email?: string; name?: string } = {}) {
  const f = await tx(prisma, (t) => order(t, { lines: [{ variantId, qty: 2 }], method, codFee: method === 'COD' ? 4000 : 0, shippingFee: 7000 }));
  await prisma.order.update({ where: { id: f.orderId }, data: { contactEmail: o.email ?? `buyer${uniq()}@example.com`, shipName: o.name ?? 'Hema Rajan', shipPincode: '682011', shipStateCode: '32', placedAt: new Date(), paymentStatus: 'UNPAID' } });   // as checkout leaves a pending order
  if (method === 'COD') await tx(prisma, (t) => fn.placeCodOrder(t, f.orderId, 'CUSTOMER'));
  else {
    const a = await tx(prisma, (t) => attempt(t, f.orderId, f.total));
    await tx(prisma, (t) => capture(t, { providerOrderId: a.providerOrderId, paymentId: `pay_${uniq()}`, amount: f.total }));
  }
  return f;
}
/** Until dispatch exists (task 5.2): the state a shipped order is in. */
async function shipped(orderId: number) {
  await prisma.order.update({ where: { id: orderId }, data: { status: 'CONFIRMED', fulfilmentStatus: 'SHIPPED' } });
  await prisma.shipment.create({ data: { orderId, courierName: 'DTDC', awbNumber: `AWB${uniq()}`, status: 'SHIPPED', shippedAt: new Date() } });
}
async function emails(orderNumber: string) {
  const mail = new MemoryTransport();
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`SELECT d.id FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id
    WHERE e.aggregate_id = ${orderNumber} AND e.event_type IN ('order.status_changed', 'order.email_resend') AND d.consumer = 'email.customer' AND d.status <> 'COMPLETED' ORDER BY d.id`;
  for (const r of rows) await processEmailDelivery({ prisma, transport: mail, from: 'ArtQ <no-reply@artq.in>', log }, 'email.customer', Number(r.id));
  return mail.sent;
}

describe('list', () => {
  it('orders:read for STAFF and ADMIN (no token 401); newest first; contact masked for STAFF only', async () => {
    const a = await placed('COD', { email: `list${uniq()}@example.com` });
    expect((await call('get', '/orders', undefined, null)).status).toBe(401);
    const res = await call('get', '/orders?limit=100');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const row = res.body.data.find((x: { id: number }) => x.id === a.orderId);
    expect(row).toMatchObject({ orderNumber: a.orderNumber, status: 'PLACED', paymentStatus: 'COD_PENDING', fulfilmentStatus: 'UNFULFILLED', returnStatus: 'NONE', paymentMethod: 'COD', itemCount: 2, total: a.total,
      customer: { name: 'Hema Rajan', city: 'Kochi', pincode: '682011', isGuest: true, email: expect.stringMatching(/^list.*@example\.com$/), phone: '+919800000000' } });
    expect(res.body.data[0].id).toBeGreaterThanOrEqual(a.orderId);
    const staff = (await call('get', '/orders?limit=100', undefined, STAFF)).body.data.find((x: { id: number }) => x.id === a.orderId);
    expect(staff.customer).toMatchObject({ email: 'l***@example.com', phone: '+********0000' });
  });

  it('filters: each status dimension, method, open exception, date range (India days), search by number/email/name/phone; bad filters 400', async () => {
    const cod = await placed('COD', { name: `Zubin ${uniq()}` });
    const paid = await placed('RAZORPAY');
    await prisma.order.update({ where: { id: paid.orderId }, data: { hasOpenException: true } });
    const ids = async (q: string) => ((await call('get', `/orders?limit=100&${q}`)).body.data as { id: number }[]).map((r) => r.id);
    expect(await ids('method=COD')).toContain(cod.orderId);
    expect(await ids('method=COD')).not.toContain(paid.orderId);
    expect(await ids('paymentStatus=PAID')).toContain(paid.orderId);
    expect(await ids('status=PLACED&fulfilmentStatus=UNFULFILLED&returnStatus=NONE')).toEqual(expect.arrayContaining([cod.orderId, paid.orderId]));
    expect(await ids('exception=1')).toEqual([paid.orderId]);
    expect(await ids(`q=${cod.orderNumber.toLowerCase()}`)).toEqual([cod.orderId]);
    expect(await ids('q=zubin')).toEqual([cod.orderId]);
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    expect(await ids(`from=${today}&to=${today}`)).toEqual(expect.arrayContaining([cod.orderId, paid.orderId]));
    expect(await ids('to=2020-01-01')).toEqual([]);
    expect(await ids('q=98000')).toEqual(expect.arrayContaining([cod.orderId]));
    expect((await call('get', '/orders?status=SHIPPED')).status).toBe(400);
    expect(fields(await call('get', '/orders?from=2026-10-05&to=2026-10-01'))).toEqual({ to: 'Use a date on or after the start date' });
    expect((await call('get', '/orders?from=2026-13-40')).status).toBe(400);
    expect((await call('get', `/orders?q=${'x'.repeat(101)}`)).status).toBe(400);
    expect((await call('get', '/orders?limit=101')).status).toBe(400);
  });
});

describe('detail', () => {
  it('everything about the order: items, totals, address, payments, history with who did it, actions; 404 for none; masked for STAFF', async () => {
    const o = await placed('RAZORPAY');
    const res = await call('get', `/orders/${o.orderId}`);
    expect(res.body).toMatchObject({
      id: o.orderId, version: expect.any(Number), contactMasked: false, status: 'PLACED', paymentStatus: 'PAID',
      items: [{ quantity: 2, unitPrice: 50_000, lineTotal: 100_000 }],
      totals: { subtotal: 100_000, shippingFee: 7000, total: o.total, capturedAmount: o.total },
      shippingAddress: { fullName: 'Hema Rajan', pincode: '682011', stateId: kerala },
      attempts: [{ amount: o.total }], payments: [{ amount: o.total, status: 'CAPTURED', allocation: 'APPLIED' }],
      actions: ['confirm', 'edit-address', 'cancel'], resendable: ['order_placed'],
    });
    expect(res.body.history.map((h: { dimension: string; to: string }) => `${h.dimension}:${h.to}`)).toEqual(expect.arrayContaining(['ORDER:PLACED', 'PAYMENT:PAID']));
    expect((await call('get', `/orders/${o.orderId}`, undefined, STAFF)).body).toMatchObject({ contactMasked: true, customer: { email: 'b***@example.com' }, shippingAddress: { phone: '+919800000000' } });
    expect((await call('get', '/orders/999999')).status).toBe(404);
    expect((await call('get', '/orders/abc')).status).toBe(400);
  });
});

describe('transitions', () => {
  it('confirm → pack: history by the staff member, version bumps, audited; the customer gets "confirmed" (unless told not to)', async () => {
    const o = await placed('COD');
    const v0 = (await call('get', `/orders/${o.orderId}`)).body.version;
    const c = await call('post', `/orders/${o.orderId}/confirm`, {}, STAFF);
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: 'CONFIRMED', fulfilmentStatus: 'UNFULFILLED', version: v0 + 1, actions: ['pack', 'edit-address', 'cancel'], resendable: ['order_placed', 'order_confirmed'] });
    expect(c.body.history.at(-1)).toMatchObject({ dimension: 'ORDER', from: 'PLACED', to: 'CONFIRMED', actor: 'ADMIN', actorName: 'STAFF person' });
    const p = await call('post', `/orders/${o.orderId}/pack`, {}, STAFF);
    expect(p.body).toMatchObject({ fulfilmentStatus: 'PACKED', actions: ['ship', 'cancel'] });
    expect(await prisma.auditLog.count({ where: { entity: 'order', entityId: String(o.orderId), action: { in: ['order.confirm', 'order.pack'] } } })).toBe(2);
    const sent = await emails(o.orderNumber);
    expect(sent.map((m) => m.subject)).toEqual([`Order ${o.orderNumber} confirmed`]);
    expect(sent[0]!.text).toContain('Hi Hema, we’ve confirmed your order');
    expect((await prisma.emailLog.findFirstOrThrow({ where: { template: 'order_confirmed', orderId: o.orderId } })).status).toBe('SENT');   // listed on the order

    const quiet = await placed('COD');
    await call('post', `/orders/${quiet.orderId}/confirm`, { notifyCustomer: false });
    expect(await emails(quiet.orderNumber)).toEqual([]);
    expect(missingAudit).toEqual([]);
  });

  it('wrong state → 422 INVALID_TRANSITION saying where the order is; unpaid orders cannot be confirmed; not-found 404; bad body 400', async () => {
    const o = await placed('COD');
    const early = await call('post', `/orders/${o.orderId}/pack`, {});
    expect(early.status).toBe(422);
    expect(early.body.error).toMatchObject({ code: 'INVALID_TRANSITION', message: 'This order can’t be packed now: it is placed, not packed, cash on delivery. Reload to see its latest state.' });
    const unpaid = await tx(prisma, (t) => order(t, { lines: [{ variantId, qty: 1 }] }));
    expect((await call('post', `/orders/${unpaid.orderId}/confirm`, {})).body.error.code).toBe('INVALID_TRANSITION');
    expect((await call('post', `/orders/${o.orderId}/deliver`, {})).body.error.code).toBe('INVALID_TRANSITION');
    expect((await call('post', '/orders/999999/confirm', {})).status).toBe(404);
    expect((await call('post', `/orders/${o.orderId}/confirm`, { notifyCustomer: 'yes' })).status).toBe(400);
    expect((await call('post', `/orders/${o.orderId}/pack`, { extra: 1 })).status).toBe(400);
  });

  it('two people press Confirm at once: the order changes once, one history row, one email', async () => {
    const o = await placed('RAZORPAY');
    const r = await race(6, () => call('post', `/orders/${o.orderId}/confirm`, {}).then((x) => { if (x.status !== 200) throw new Error(x.body.error.code); return x; }));
    expect(r).toEqual({ ok: 1, errors: ['INVALID_TRANSITION'] });
    expect(await prisma.orderStatusHistory.count({ where: { orderId: o.orderId, toValue: 'CONFIRMED' } })).toBe(1);
    expect(await emails(o.orderNumber)).toHaveLength(1);
  });

  it('shipped → out for delivery → delivered: the shipment follows; COD cash is now collected (payment history); "delivered" email', async () => {
    const o = await placed('COD');
    await shipped(o.orderId);
    expect((await call('get', `/orders/${o.orderId}`)).body.actions).toEqual(['out-for-delivery', 'deliver']);
    expect((await call('post', `/orders/${o.orderId}/out-for-delivery`, {}, STAFF)).body).toMatchObject({ fulfilmentStatus: 'OUT_FOR_DELIVERY', shipment: { status: 'OUT_FOR_DELIVERY' }, actions: ['deliver'] });
    const d = await call('post', `/orders/${o.orderId}/deliver`, {}, STAFF);
    expect(d.body).toMatchObject({ fulfilmentStatus: 'DELIVERED', paymentStatus: 'COD_COLLECTED', shipment: { status: 'DELIVERED', deliveredAt: expect.any(String) }, actions: [], resendable: ['order_placed', 'order_confirmed', 'order_shipped', 'order_delivered'] });
    expect(d.body.history.slice(-2).map((h: { dimension: string; from: string; to: string }) => `${h.dimension}:${h.from}→${h.to}`).sort()).toEqual(['FULFILMENT:OUT_FOR_DELIVERY→DELIVERED', 'PAYMENT:COD_PENDING→COD_COLLECTED']);
    expect((await emails(o.orderNumber)).map((m) => m.subject)).toEqual([`Order ${o.orderNumber} delivered`]);
    expect((await call('post', `/orders/${o.orderId}/deliver`, {})).body.error.code).toBe('INVALID_TRANSITION');   // once

    const prepaid = await placed('RAZORPAY');
    await shipped(prepaid.orderId);
    expect((await call('post', `/orders/${prepaid.orderId}/deliver`, { notifyCustomer: false })).body).toMatchObject({ fulfilmentStatus: 'DELIVERED', paymentStatus: 'PAID' });
  });
});

describe('address correction and staff note', () => {
  const address = (o: object = {}) => ({ fullName: 'Hema R', phone: '+919847012345', line1: '14 Rose Villa', line2: 'Kadavanthra', landmark: 'SBI', city: 'Kochi', stateId: kerala, pincode: '682011', ...o });

  it('before packing: saved with the state’s name and GST code, version checked, audited before/after', async () => {
    const o = await placed('COD');
    const { version } = (await call('get', `/orders/${o.orderId}`)).body;
    const res = await call('patch', `/orders/${o.orderId}`, { version, shippingAddress: address({ stateId: karnataka, pincode: '560001', city: 'Bengaluru' }) }, STAFF);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: version + 1, shippingAddress: { fullName: 'Hema R', line1: '14 Rose Villa', line2: 'Kadavanthra', landmark: 'SBI', city: 'Bengaluru', state: 'Karnataka', stateId: karnataka, pincode: '560001' } });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.orderId }, select: { shipStateCode: true } })).toEqual({ shipStateCode: '29' });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.address.update', entityId: String(o.orderId) } });
    expect(audit.before).toMatchObject({ shipPincode: '682011' });
    expect(audit.after).toMatchObject({ shipPincode: '560001' });
    const stale = await call('patch', `/orders/${o.orderId}`, { version, adminNote: 'x' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { current: { version: version + 1 } } });
  });

  it('checked like checkout, each problem on its field: unknown pincode, wrong state, not delivered, no COD, road-only items to an air-only area', async () => {
    const o = await placed('COD');
    const patch = async (a: object) => fields(await call('patch', `/orders/${o.orderId}`, { version: (await call('get', `/orders/${o.orderId}`)).body.version, shippingAddress: address(a) }));
    expect(await patch({ pincode: '999999' })).toEqual({ 'shippingAddress.pincode': 'This pincode isn’t in the postal directory. Check the number.' });
    expect(await patch({ stateId: karnataka })).toEqual({ 'shippingAddress.pincode': 'This pincode is in Kerala' });
    expect(await patch({ stateId: 999 })).toEqual({ 'shippingAddress.stateId': 'Choose a state' });
    await prisma.pincodeServiceability.create({ data: { pincode: '560001', isServiceable: true, codAvailable: false } });
    expect(await patch({ stateId: karnataka, pincode: '560001' })).toEqual({ 'shippingAddress.pincode': 'Cash on delivery isn’t available at this pincode' });
    await prisma.pincodeServiceability.update({ where: { pincode: '560001' }, data: { isServiceable: false } });
    expect(await patch({ stateId: karnataka, pincode: '560001' })).toEqual({ 'shippingAddress.pincode': 'We don’t deliver to this pincode' });
    await prisma.pincodeServiceability.delete({ where: { pincode: '560001' } });
    const an = (await prisma.state.findFirstOrThrow({ where: { name: 'Andaman and Nicobar Islands' } })).id;
    await prisma.productVariant.update({ where: { id: variantId }, data: { shippingClass: 'SURFACE_ONLY' } });
    expect(await patch({ stateId: an, pincode: '744101' })).toEqual({ 'shippingAddress.pincode': 'Some items travel by road only and can’t be delivered to this pincode' });
    await prisma.productVariant.update({ where: { id: variantId }, data: { shippingClass: 'STANDARD' } });
    expect(await patch({ fullName: '', pincode: '68201' })).toMatchObject({ 'shippingAddress.fullName': 'Enter the name for delivery', 'shippingAddress.pincode': 'Enter a 6-digit pincode' });
    expect(fields(await call('patch', `/orders/${o.orderId}`, { version: 1 }))).toEqual({ '': 'Nothing to change' });
  });

  it('after packing the address is locked (422) but the staff note still saves (2,000 characters; 2,001 refused)', async () => {
    const o = await placed('RAZORPAY');
    await call('post', `/orders/${o.orderId}/confirm`, { notifyCustomer: false });
    let { version } = (await call('post', `/orders/${o.orderId}/pack`, {})).body;
    const locked = await call('patch', `/orders/${o.orderId}`, { version, shippingAddress: address() });
    expect(locked.status).toBe(422);
    expect(locked.body.error.message).toBe('The delivery address can only change before the order is packed; it is confirmed, packed, paid.');
    const note = await call('patch', `/orders/${o.orderId}`, { version, adminNote: 'x'.repeat(2000) }, STAFF);
    expect(note.body).toMatchObject({ notes: { admin: 'x'.repeat(2000) } });
    version = note.body.version;
    expect(fields(await call('patch', `/orders/${o.orderId}`, { version, adminNote: 'x'.repeat(2001) }))).toEqual({ adminNote: 'Use at most 2,000 characters' });
    expect((await call('patch', `/orders/${o.orderId}`, { version, adminNote: '  ' })).body.notes.admin).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'order.note.update', entityId: String(o.orderId) } })).toBe(2);
  });
});

describe('resend email and packing slip', () => {
  it('sends a fitting email again (a new email each time, listed on the order); one that does not fit the order is refused', async () => {
    const o = await placed('COD');
    await call('post', `/orders/${o.orderId}/resend-email`, { template: 'order_placed' }, STAFF);
    await call('post', `/orders/${o.orderId}/resend-email`, { template: 'order_placed' }, STAFF);
    const sent = await emails(o.orderNumber);
    expect(sent.map((m) => m.subject)).toEqual([`Order ${o.orderNumber} placed`, `Order ${o.orderNumber} placed`]);
    expect((await call('get', `/orders/${o.orderId}`)).body.emails.filter((e: { template: string }) => e.template === 'order_placed')).toHaveLength(2);
    expect((await call('post', `/orders/${o.orderId}/resend-email`, { template: 'order_delivered' })).body.error).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(fields(await call('post', `/orders/${o.orderId}/resend-email`, { template: 'otp' }))).toEqual({ template: 'Choose an email' });
    expect(await prisma.auditLog.count({ where: { action: 'order.email.resend', entityId: String(o.orderId) } })).toBe(2);
  });

  it('packing slip: a PDF for a placed order (STAFF may print it); refused for an unpaid one', async () => {
    const o = await placed('COD');
    const res = await call('get', `/orders/${o.orderId}/packing-slip`, undefined, STAFF).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(`inline; filename="packing-slip-${o.orderNumber}.pdf"`);
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    const unpaid = await tx(prisma, (t) => order(t, { lines: [{ variantId, qty: 1 }] }));
    expect((await call('get', `/orders/${unpaid.orderId}/packing-slip`)).body.error.code).toBe('INVALID_TRANSITION');
    expect((await call('get', '/orders/999999/packing-slip')).status).toBe(404);
  });
});

describe('who may do what', () => {
  it('a customer token is refused; STAFF can fulfil (orders:fulfil); every mutation is audited', async () => {
    const o = await placed('COD');
    const customer = await prisma.user.create({ data: { email: `c${uniq()}@example.com`, role: 'CUSTOMER', status: 'ACTIVE', passwordHash: await hashPassword('orders-password-1') } });
    const tok = (await request(app).post('/v1/admin/auth/login').set('Origin', ORIGIN).send({ email: customer.email, password: 'orders-password-1' })).body.accessToken as string | undefined;
    expect((await call('get', '/orders', undefined, { token: tok ?? randomUUID() })).status).toBe(401);
    expect((await call('post', `/orders/${o.orderId}/confirm`, {}, STAFF)).status).toBe(200);
    expect(missingAudit).toEqual([]);
  });
});
