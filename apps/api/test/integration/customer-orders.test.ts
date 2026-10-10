// Task 5.7 / AT-12 on real PostgreSQL + Redis: customer and guest order access. The owner's list and detail; the
// tracking link (read-only, masked, wrong / other order's / expired token → 404); the email code (only for the order's
// email, bound to the order, wrong code and another order's code refused); the order cookie (HttpOnly, Path=/v1/orders,
// 1 hour, opens one order only, an expired one does nothing); guest cancel and return with photos; attachments (this
// order's return photo → 5-minute link; another order's or unattached → 404); the invoice link; the emailed link.
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { authRouter } from '../../src/auth/routes.js';
import { AuthService, DEFAULT_AUTH_TIMINGS } from '../../src/auth/service.js';
import { RedisSessionCache } from '../../src/auth/session-cache.js';
import * as fn from '../../src/db/functions.js';
import { processEmailDelivery } from '../../src/email/consumer.js';
import { MemoryTransport } from '../../src/email/transport.js';
import { hashPassword } from '../../src/lib/password.js';
import { MediaService } from '../../src/media/service.js';
import { orderAccessCookieValue, trackingToken } from '../../src/orders/access.js';
import { customerOrdersRouter } from '../../src/orders/customer-routes.js';
import { DispatchService } from '../../src/orders/dispatch.js';
import { seedGeo, seedSettings, seedShipping } from '../../src/seed/steps.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { attempt, capture, catalog, order, tx, uniq } from '../helpers/fixtures.js';
import { MemoryObjectStore } from '../helpers/memory-store.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const WEB = 'http://localhost:3000';
const SECRET = 'test-link-secret-0123456789abcdef0123';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const log = pino({ level: 'silent' });
const COOKIE = '__Secure-aq_order_test';
let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express, variantId: number, dispatch: DispatchService;

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  await seedShipping(prisma); await seedGeo(prisma); await seedSettings(prisma);
  variantId = (await tx(prisma, (t) => catalog(t, [[{ price: 50_000, onHand: 1000 }]]))).products[0]!.variantIds[0]!;
  const cache = new RedisSessionCache(redis);
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: SECRET, webUrl: WEB, adminUrl: 'http://localhost:5173' });
  const store = new MemoryObjectStore();
  const media = new MediaService(prisma, { store, buckets: { PUBLIC: 'pub', PRIVATE: 'priv' }, publicBaseUrl: 'https://cdn.test' }, async () => {});
  dispatch = new DispatchService(prisma, { store, buckets: { PUBLIC: 'pub', PRIVATE: 'priv' } });
  const deps = { prisma, cache, jwt: JWT };
  app = createApp({ version: 't', origins: { storefront: [WEB], admin: [] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [authRouter({ ...deps, service, env: 'test', refreshMaxAgeS: DEFAULT_AUTH_TIMINGS.refreshIdleS, limiter: { hit: async () => ({ count: 0, resetMs: 60_000 }) } }),
      customerOrdersRouter({ ...deps, log, env: 'test', linkSecret: SECRET, auth: service, media, dispatch })] });
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });

async function customer() {
  const email = `c${uniq()}@example.com`;
  const u = await prisma.user.create({ data: { email, name: 'Hema', role: 'CUSTOMER', status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword('order-password-1') } });
  const res = await request(app).post('/v1/auth/login').set('Origin', WEB).send({ email, password: 'order-password-1' });
  return { id: u.id, token: res.body.accessToken as string };
}
/** 2 × ₹500, shipping ₹70, prepaid; `state` sets fulfilment (DELIVERED adds a shipment delivered an hour ago). */
async function placed(o: { userId?: number | null; delivered?: boolean; email?: string } = {}) {
  const f = await tx(prisma, (t) => order(t, { lines: [{ variantId, qty: 2 }], shippingFee: 7000 }));
  const orderNumber = f.orderNumber.toUpperCase();
  const contactEmail = o.email ?? `g${uniq()}@example.com`;
  await prisma.order.update({ where: { id: f.orderId }, data: { orderNumber, paymentStatus: 'UNPAID', userId: o.userId ?? null, contactEmail, shipName: 'Hema Rajan', shipLine1: '12 Rose Villa', shipPhone: '+919847012345' } });
  const a = await tx(prisma, (t) => attempt(t, f.orderId, f.total));
  await tx(prisma, (t) => capture(t, { providerOrderId: a.providerOrderId, paymentId: `pay_${uniq()}`, amount: f.total }));
  if (o.delivered) {
    await prisma.inventoryReservation.updateMany({ where: { orderId: f.orderId }, data: { status: 'CONSUMED', consumedAt: new Date() } });
    await prisma.$executeRaw`UPDATE product_variants SET reserved = reserved - 2, on_hand = on_hand - 2 WHERE id = ${variantId}`;
    await prisma.order.update({ where: { id: f.orderId }, data: { status: 'CONFIRMED', fulfilmentStatus: 'DELIVERED' } });
    await prisma.shipment.create({ data: { orderId: f.orderId, courierName: 'DTDC', awbNumber: `G${uniq()}`, status: 'DELIVERED', shippedAt: new Date(Date.now() - 86_400_000), deliveredAt: new Date(Date.now() - 3_600_000) } });
  }
  const row = await prisma.order.findUniqueOrThrow({ where: { id: f.orderId } });
  return { id: f.orderId, orderNumber, contactEmail, item: f.items[0]!.orderItemId, token: trackingToken(SECRET, row), total: f.total };
}
const web = (method: 'get' | 'post', path: string, o: { cookie?: string; bearer?: string; body?: object; key?: boolean } = {}) => {
  let r = request(app)[method](`/v1${path}`).set('Origin', WEB);
  if (o.cookie) r = r.set('Cookie', `${COOKIE}=${o.cookie}`);
  if (o.bearer) r = r.set('Authorization', `Bearer ${o.bearer}`);
  if (o.key) r = r.set('Idempotency-Key', randomUUID());
  return method === 'post' ? r.send(o.body ?? {}) : r;
};
/** The newest code mailed for this order (read from the outbox before the email is sent). */
async function lastCode(orderId: number, email: string) {
  const [e] = await prisma.$queryRaw<{ code: string }[]>`SELECT payload->'data'->>'code' AS code FROM outbox_events WHERE event_type = 'email.auth'
    AND payload->>'to' = ${email} AND payload->'data'->>'purpose' = 'GUEST_ORDER_ACCESS' ORDER BY id DESC LIMIT 1`;
  expect(await prisma.otpCode.count({ where: { orderId, purpose: 'GUEST_ORDER_ACCESS' } })).toBeGreaterThan(0);
  return e!.code;
}
async function access(o: { orderNumber: string; id: number; contactEmail: string }) {
  await web('post', `/orders/${o.orderNumber}/access/request`, { body: { email: o.contactEmail } });
  const res = await web('post', `/orders/${o.orderNumber}/access/verify`, { body: { email: o.contactEmail, code: await lastCode(o.id, o.contactEmail) } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return /aq_order_test=([^;]+)/.exec(String(res.headers['set-cookie']))![1]!;
}

describe('signed-in owner', () => {
  it('lists own orders (not pending ones), opens own order; another customer’s order → 404; not signed in → 401', async () => {
    const me = await customer(), other = await customer();
    const mine = await placed({ userId: me.id });
    const list = await web('get', '/me/orders', { bearer: me.token });
    expect(list.body.data).toEqual([{ orderNumber: mine.orderNumber, createdAt: expect.any(String), displayStatus: 'Order placed', total: mine.total, itemCount: 2, firstItem: { name: 'n', imageUrl: null } }]);
    const view = (await web('get', `/me/orders/${mine.orderNumber}`, { bearer: me.token })).body;
    expect(view).toMatchObject({ access: 'owner', displayStatus: 'Order placed', shippingAddress: { name: 'Hema Rajan', phone: '+919847012345' }, actions: { canCancel: true, canRetryPayment: false, canRequestReturn: false, canDownloadInvoice: false } });
    expect(view.timeline.map((t: { label: string }) => t.label)).toContain('Payment received');
    expect((await web('get', `/me/orders/${mine.orderNumber}`, { bearer: other.token })).status).toBe(404);
    expect((await web('get', `/me/orders/${mine.orderNumber}`)).status).toBe(401);
    expect((await web('get', `/me/orders/${mine.orderNumber}/invoice`, { bearer: me.token })).body.error.message).toMatch(/no invoice yet/);
  });
});

describe('AT-12: guest access', () => {
  it('tracking link: read-only and masked; a wrong token, another order’s token or one 90+ days after closing → 404', async () => {
    const o = await placed(), p = await placed();
    const t = await web('get', `/orders/track/${o.orderNumber}?token=${o.token}`);
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ access: 'tracking', shippingAddress: { name: 'Hema', lines: ['Kochi, Kerala 682016'], phone: '+********2345' }, actions: { canCancel: false, canRetryPayment: false, canRequestReturn: false, canDownloadInvoice: false } });
    expect((await web('get', `/orders/track/${o.orderNumber}?token=${p.token}`)).status).toBe(404);
    expect((await web('get', `/orders/track/${o.orderNumber}?token=${o.token.slice(0, -2)}xx`)).status).toBe(404);
    expect((await web('get', `/orders/track/${o.orderNumber}`)).status).toBe(400);
    await prisma.order.update({ where: { id: o.id }, data: { status: 'COMPLETED', completedAt: new Date(Date.now() - 91 * 86_400_000) } });
    expect((await web('get', `/orders/track/${o.orderNumber}?token=${o.token}`)).status).toBe(404);
    // The tracking token is no key for actions.
    expect((await web('get', `/orders/${p.orderNumber}`)).status).toBe(404);
    expect((await web('post', `/orders/${p.orderNumber}/cancel`, { key: true })).status).toBe(404);
  });

  it('email code: only for the order’s email (same answer otherwise); wrong code and another order’s code refused', async () => {
    const o = await placed(), p = await placed();
    const wrong = await web('post', `/orders/${o.orderNumber}/access/request`, { body: { email: 'someone@else.in' } });
    expect([wrong.status, wrong.body.sent]).toEqual([200, true]);
    expect(await prisma.otpCode.count({ where: { orderId: o.id } })).toBe(0);
    expect((await web('post', '/orders/AQ0000001/access/request', { body: { email: 'x@y.in' } })).body.sent).toBe(true);
    await web('post', `/orders/${o.orderNumber}/access/request`, { body: { email: o.contactEmail.toUpperCase() } });
    const code = await lastCode(o.id, o.contactEmail);
    await web('post', `/orders/${p.orderNumber}/access/request`, { body: { email: p.contactEmail } });
    // o's code does not open p (different email and different order), nor a bad code o.
    expect((await web('post', `/orders/${p.orderNumber}/access/verify`, { body: { email: o.contactEmail, code } })).body.error.code).toBe('OTP_INVALID');
    const bad = await web('post', `/orders/${o.orderNumber}/access/verify`, { body: { email: o.contactEmail, code: code === '000000' ? '111111' : '000000' } });
    expect([bad.status, bad.body.error.code, bad.headers['set-cookie']]).toEqual([422, 'OTP_INVALID', undefined]);
    expect(Object.keys((await web('post', `/orders/${o.orderNumber}/access/verify`, { body: { email: 'nope', code: '12' } })).body.error.details.map((x: { path: string }) => x.path))).toHaveLength(2);
    const ok = await web('post', `/orders/${o.orderNumber}/access/verify`, { body: { email: o.contactEmail, code } });
    expect(ok.status).toBe(200);
    expect(String(ok.headers['set-cookie'])).toMatch(/^__Secure-aq_order_test=[A-Za-z0-9_-]+; Path=\/v1\/orders; Max-Age=3600; HttpOnly; Secure; SameSite=Strict$/);
    expect(ok.body).toMatchObject({ access: 'guest', shippingAddress: { name: 'Hema Rajan', lines: ['12 Rose Villa', 'Kochi, Kerala 682016'] }, actions: { canCancel: true } });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).contactEmailVerifiedAt).not.toBeNull();
    expect((await web('post', `/orders/${o.orderNumber}/access/verify`, { body: { email: o.contactEmail, code } })).body.error.code).toBe('OTP_INVALID');   // single use
  });

  it('the cookie opens one order only; an expired cookie does nothing; guest cancel works with it', async () => {
    const o = await placed(), p = await placed();
    const cookie = await access(o);
    expect((await web('get', `/orders/${o.orderNumber}`, { cookie })).body.access).toBe('guest');
    expect((await web('get', `/orders/${p.orderNumber}`, { cookie })).status).toBe(404);
    expect((await web('post', `/orders/${p.orderNumber}/cancel`, { cookie, key: true })).status).toBe(404);
    expect((await web('get', '/me/orders', { cookie })).status).toBe(401);
    const stale = orderAccessCookieValue(SECRET, o.id, new Date(Date.now() - 2 * 3600_000));
    expect((await web('get', `/orders/${o.orderNumber}`, { cookie: stale })).status).toBe(404);
    expect((await web('get', `/orders/${o.orderNumber}`, { cookie: orderAccessCookieValue('another-secret-0123456789abcdef0123', o.id) })).status).toBe(404);
    const c = await web('post', `/orders/${o.orderNumber}/cancel`, { cookie, key: true, body: { reason: 'Ordered twice' } });
    expect([c.status, c.body.status, c.body.refund.amount]).toEqual([200, 'CANCELLED', o.total]);
    expect((await web('get', `/orders/${o.orderNumber}`, { cookie })).body).toMatchObject({ displayStatus: 'Cancelled', actions: { canCancel: false } });
  });

  it('guest return with a photo; attachments: this order’s return photo → 5-minute link, another order’s or unattached → 404', async () => {
    const o = await placed({ delivered: true }), p = await placed({ delivered: true });
    const cookie = await access(o);
    const view = (await web('get', `/orders/${o.orderNumber}`, { cookie })).body;
    expect(view.actions.canRequestReturn).toBe(true);
    expect(view.items[0].returnableQty).toBe(2);
    const pre = await web('post', `/orders/${o.orderNumber}/uploads/presign`, { cookie, body: { filename: 'a.jpg', contentType: 'image/jpeg', size: 10 } });
    expect(pre.status).toBe(201);
    const m = await prisma.media.findUniqueOrThrow({ where: { id: pre.body.media.id } });
    expect([m.uploadedBy, m.ownerScope]).toEqual([null, `return:${o.id}`]);
    expect((await web('get', `/orders/${o.orderNumber}/uploads/${m.id}`, { cookie })).body.media.status).toBe('PENDING_UPLOAD');
    await prisma.media.update({ where: { id: m.id }, data: { status: 'READY', renditions: { 640: `${m.key}.w640.webp` } } });
    const ret = await web('post', `/orders/${o.orderNumber}/returns`, { cookie, key: true, body: { reason: 'DAMAGED', items: [{ orderItemId: o.item, quantity: 1 }], mediaIds: [m.id] } });
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    const after = (await web('get', `/orders/${o.orderNumber}`, { cookie })).body;
    expect(after).toMatchObject({ displayStatus: 'Return in progress', items: [{ returnableQty: 1 }], returns: [{ status: 'REQUESTED', items: [{ quantity: 1 }], photos: [{ id: m.id, url: expect.stringMatching(/^https:\/\/storage\.test\/priv\/.*exp=300/) }] }] });
    const link = await web('get', `/orders/${o.orderNumber}/attachments/${m.id}`, { cookie });
    expect([link.status, link.headers.location]).toEqual([302, expect.stringMatching(/exp=300/)]);
    // The tracking view shows no photos; another order's cookie, unattached or unknown media → 404.
    expect((await web('get', `/orders/track/${o.orderNumber}?token=${o.token}`)).body.returns[0].photos).toEqual([]);
    const pCookie = await access(p);
    expect((await web('get', `/orders/${p.orderNumber}/attachments/${m.id}`, { cookie: pCookie })).status).toBe(404);
    const loose = await prisma.media.create({ data: { key: `private/x/${uniq()}.jpg`, visibility: 'PRIVATE', kind: 'IMAGE', declaredMime: 'image/jpeg', declaredSize: 10, ownerScope: `return:${o.id}`, status: 'READY' } });
    expect((await web('get', `/orders/${o.orderNumber}/attachments/${loose.id}`, { cookie })).status).toBe(404);
    expect((await web('get', `/orders/${o.orderNumber}/attachments/999999`, { cookie })).status).toBe(404);
  });

  it('invoice: the signed link once the order has shipped (owner and guest); none for the tracking link', async () => {
    const me = await customer();
    const o = await placed({ userId: me.id });
    await prisma.order.update({ where: { id: o.id }, data: { status: 'CONFIRMED', fulfilmentStatus: 'PACKED' } });
    const total = o.total, tax = Math.round(total * 18 / 118), cgst = Math.floor(tax / 2);
    const party = { name: 'x', lines: [], stateCode: '32', state: 'Kerala', gstin: null };
    await tx(prisma, (t) => fn.dispatchOrder(t, { orderId: o.id, courier: 'DTDC', awb: `INV${uniq()}`.toUpperCase(), trackingUrl: null, weightG: null, notify: false, actorId: 0,
      invoice: { fy: '26-27', seller: party, buyer: party, place_of_supply: '32', lines: [{ kind: 'ITEM', description: 'n', sku: 's', hsn: null, quantity: 2, net: total, ratePercent: 18, taxable: total - tax, cgst, sgst: tax - cgst, igst: 0 }],
        taxable_total: total - tax, cgst_total: cgst, sgst_total: tax - cgst, igst_total: 0, rounding_adjustment: 0, grand_total: total } as never }));
    const inv = await prisma.invoice.findFirstOrThrow({ where: { orderId: o.id } });
    const r = await web('get', `/me/orders/${o.orderNumber}/invoice`, { bearer: me.token });
    expect(r.body).toEqual({ number: inv.number, url: expect.stringMatching(/^https:\/\/storage\.test\/priv\/.*exp=300/) });
    expect((await web('get', `/me/orders/${o.orderNumber}`, { bearer: me.token })).body.actions.canDownloadInvoice).toBe(true);
    const cookie = await access(o);
    expect((await web('get', `/orders/${o.orderNumber}/invoice`, { cookie })).body.number).toBe(inv.number);
    expect((await web('get', `/orders/track/${o.orderNumber}?token=${o.token}`)).body.actions.canDownloadInvoice).toBe(false);
  });

  it('the order emails link to the order page; the link opens the tracking view', async () => {
    const o = await placed();
    const id = await fn.emit(prisma, { aggregateType: 'order', aggregateId: o.orderNumber, type: 'order.placed', payload: { order_id: o.id }, consumers: ['email.customer'] });
    const [d] = await prisma.$queryRaw<{ id: bigint }[]>`SELECT id FROM outbox_deliveries WHERE event_id = ${id}::bigint`;
    const mail = new MemoryTransport();
    await processEmailDelivery({ prisma, transport: mail, from: 'x@artq.in', log, links: { webUrl: WEB, linkSecret: SECRET, setPasswordTtlS: 60 } }, 'email.customer', Number(d!.id));
    const url = new URL(/https?:\/\/\S+\/track\/\S+/.exec(mail.sent[0]!.text)![0]);
    expect(url.pathname).toBe(`/track/${o.orderNumber}`);
    expect((await web('get', `/orders/track/${o.orderNumber}?token=${url.searchParams.get('token')}`)).body.access).toBe('tracking');
  });
});
