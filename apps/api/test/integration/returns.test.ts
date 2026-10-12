// Task 5.5: returns on real PostgreSQL + Redis, through the customer and admin endpoints. Customer: request with photos
// (upload presign/complete, private, claimed once), Idempotency-Key replay, delivered-and-within-the-window only,
// quantities bounded across requests and under concurrency (the task's acceptance check), field errors on the right
// field. Staff: list and detail (photos as short-lived links), permissions, decide (partial / reject with a reason),
// in transit, receive, inspect (sellable restocked once, damaged recorded), the RETURN refund (step-up, bounded by the
// units received, replay), close; a missing item refunded without coming back; cancel; customer emails; audit.
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
import { MediaService } from '../../src/media/service.js';
import type { RateLimiter } from '../../src/middleware/rateLimit.js';
import { registerOrderRoutes } from '../../src/orders/admin-routes.js';
import { DispatchService } from '../../src/orders/dispatch.js';
import { customerReturnRouter, registerReturnRoutes } from '../../src/returns/routes.js';
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
let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express, variantId: number, store: MemoryObjectStore;
let ADMIN: { token: string }, STAFF: { token: string }, ME: { id: number; token: string };
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
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: WEB, adminUrl: ORIGIN });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log, hasRecentStepUp: async () => stepUp, onMissingAudit: (req) => missingAudit.push(`${req.method} ${req.originalUrl}`) });
  store = new MemoryObjectStore();
  const media = new MediaService(prisma, { store, buckets: { PUBLIC: 'pub', PRIVATE: 'priv' }, publicBaseUrl: 'https://cdn.test' }, async () => {});
  registerOrderRoutes(admin, prisma, new DispatchService(prisma, { store, buckets: { PUBLIC: 'pub', PRIVATE: 'priv' } }));
  registerReturnRoutes(admin, prisma, log, media);
  app = createApp({ version: 't', origins: { storefront: [WEB], admin: [ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }), admin.router, authRouter({ ...deps, service, env: 'test', refreshMaxAgeS: DEFAULT_AUTH_TIMINGS.refreshIdleS, limiter: NO_LIMIT }), customerReturnRouter({ ...deps, log, media })] });
  [ADMIN, STAFF, ME] = [await staff('ADMIN'), await staff('STAFF'), await customer()];
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });
beforeEach(() => { stepUp = true; missingAudit.length = 0; });

async function staff(role: UserRole) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  await prisma.user.create({ data: { email, name: role, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword('return-password-1') } });
  return { token: (await request(app).post('/v1/admin/auth/login').set('Origin', ORIGIN).send({ email, password: 'return-password-1' })).body.accessToken as string };
}
async function customer() {
  const email = `c${uniq()}@example.com`;
  const u = await prisma.user.create({ data: { email, name: 'Hema', role: 'CUSTOMER', status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword('return-password-1') } });
  const res = await request(app).post('/v1/auth/login').set('Origin', WEB).send({ email, password: 'return-password-1' });
  return { id: u.id, token: res.body.accessToken as string };
}
const get = (path: string, who = ADMIN) => request(app).get(`/v1/admin${path}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${who.token}`);
const post = (path: string, body: object = {}, who = ADMIN, key: string | null = null) => {
  const r = request(app).post(`/v1/admin${path}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${who.token}`);
  return (key ? r.set('Idempotency-Key', key) : r).send(body);
};
const ask = (n: string, body: object, who: { token: string } | null = ME, key = randomUUID()) => {
  const r = request(app).post(`/v1/me/orders/${n}/returns`).set('Origin', WEB).set('Idempotency-Key', key);
  return (who ? r.set('Authorization', `Bearer ${who.token}`) : r).send(body);
};
const fields = (res: request.Response) => Object.fromEntries((res.body.error?.details ?? []).map((d: { path: string; message: string }) => [d.path, d.message]));
const stock = async () => (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).onHand;

/** 3 × ₹500 + shipping ₹70, delivered `hoursAgo` hours ago to ME; prepaid (captured) or COD collected. */
async function delivered(o: { hoursAgo?: number; method?: 'RAZORPAY' | 'COD'; userId?: number | null } = {}) {
  const method = o.method ?? 'RAZORPAY';
  const f = await tx(prisma, (t) => order(t, { lines: [{ variantId, qty: 3 }], method, shippingFee: 7000, codFee: method === 'COD' ? 4000 : 0, reserve: false }));
  await prisma.order.update({ where: { id: f.orderId }, data: { paymentStatus: 'UNPAID', userId: o.userId === undefined ? ME.id : o.userId, contactEmail: `b${uniq()}@example.com` } });
  if (method === 'COD') {
    await tx(prisma, (t) => fn.reserveOrder(t, f.orderId));
    await tx(prisma, (t) => fn.placeCodOrder(t, f.orderId, 'CUSTOMER'));
  } else {
    await tx(prisma, (t) => fn.reserveOrder(t, f.orderId));
    const a = await tx(prisma, (t) => attempt(t, f.orderId, f.total));
    await tx(prisma, (t) => capture(t, { providerOrderId: a.providerOrderId, paymentId: `pay_${uniq()}`, amount: f.total }));
  }
  await prisma.inventoryReservation.updateMany({ where: { orderId: f.orderId }, data: { status: 'CONSUMED', consumedAt: new Date() } });
  await prisma.$executeRaw`UPDATE product_variants SET reserved = reserved - 3, on_hand = on_hand - 3 WHERE id = ${variantId}`;
  await prisma.order.update({ where: { id: f.orderId }, data: { status: 'CONFIRMED', fulfilmentStatus: 'DELIVERED', ...(method === 'COD' ? { paymentStatus: 'COD_COLLECTED' } : {}) } });
  await prisma.shipment.create({ data: { orderId: f.orderId, courierName: 'DTDC', awbNumber: `R${uniq()}`, status: 'DELIVERED', shippedAt: new Date(Date.now() - 3 * 86_400_000), deliveredAt: new Date(Date.now() - (o.hoursAgo ?? 2) * 3_600_000) } });
  return { ...f, item: f.items[0]!.orderItemId };
}
/** A processed private return photo for the order (what upload + worker leave behind). */
const photo = (orderId: number, uploadedBy: number | null = ME.id, status: 'READY' | 'PROCESSING' = 'READY') => prisma.media.create({ data: {
  key: `private/return-photo/t/${randomUUID()}.jpg`, visibility: 'PRIVATE', kind: 'IMAGE', declaredMime: 'image/jpeg', declaredSize: 10, uploadedBy, ownerScope: `return:${orderId}`, status,
  renditions: { 320: `private/return-photo/t/${randomUUID()}/w320.webp` } } }).then((m) => m.id);
async function emails(orderNumber: string, type: string) {
  const mail = new MemoryTransport();
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`SELECT d.id FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id
    WHERE e.aggregate_id = ${orderNumber} AND e.event_type = ${type} AND d.consumer = 'email.customer' AND d.status <> 'COMPLETED' ORDER BY d.id`;
  for (const r of rows) await processEmailDelivery({ prisma, transport: mail, from: 'x@artq.in', log }, 'email.customer', Number(r.id));
  return mail.sent;
}

describe('customer request', () => {
  it('201 with the photo claimed and the order OPEN; the same key replays; the email lists the items', async () => {
    const o = await delivered();
    const p = await photo(o.orderId);
    const key = randomUUID();
    const body = { reason: 'DAMAGED', description: 'The glass cracked in transit', items: [{ orderItemId: o.item, quantity: 2 }], mediaIds: [p] };
    const res = await ask(o.orderNumber, body, ME, key);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'REQUESTED', reason: 'DAMAGED', items: [{ orderItemId: o.item, quantity: 2 }] });
    const again = await ask(o.orderNumber, body, ME, key);
    expect([again.status, again.headers['idempotent-replayed'], again.body.id]).toEqual([201, 'true', res.body.id]);
    expect((await prisma.media.findUniqueOrThrow({ where: { id: p } })).claimedAt).not.toBeNull();
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.orderId }, select: { returnStatus: true } })).toEqual({ returnStatus: 'OPEN' });
    expect(await prisma.returnRequest.count({ where: { orderId: o.orderId } })).toBe(1);
    const [mail] = await emails(o.orderNumber, 'return.status_changed');
    expect(mail!.subject).toBe(`Return request for order ${o.orderNumber} received`);
    expect(mail!.text).toContain('2 × n (l)');
  });

  it('a missing item needs no photo; any other reason does (on mediaIds); the description limit holds at 1,000', async () => {
    const o = await delivered();
    expect(fields(await ask(o.orderNumber, { reason: 'WRONG_ITEM', items: [{ orderItemId: o.item, quantity: 1 }] }))).toEqual({ mediaIds: 'Add at least one photo of the problem' });
    expect(fields(await ask(o.orderNumber, { reason: 'MISSING_ITEM', description: 'x'.repeat(1001), items: [{ orderItemId: o.item, quantity: 1 }] }))).toEqual({ description: 'Use at most 1,000 characters' });
    expect((await ask(o.orderNumber, { reason: 'MISSING_ITEM', description: 'x'.repeat(1000), items: [{ orderItemId: o.item, quantity: 1 }] })).status).toBe(201);
  });

  it('refusals: empty body on the fields, other reasons, not signed in, someone else’s order, not delivered, outside the window', async () => {
    const o = await delivered();
    expect(Object.keys(fields(await ask(o.orderNumber, {})))).toEqual(expect.arrayContaining(['reason', 'items']));
    expect(fields(await ask(o.orderNumber, { reason: 'OTHER', items: [{ orderItemId: o.item, quantity: 1 }] }))).toHaveProperty('reason');
    expect(fields(await ask(o.orderNumber, { reason: 'MISSING_ITEM', items: [{ orderItemId: o.item, quantity: 1 }, { orderItemId: o.item, quantity: 1 }] }))).toEqual({ 'items.1.orderItemId': 'Each item only once' });
    expect((await ask(o.orderNumber, { reason: 'MISSING_ITEM', items: [{ orderItemId: o.item, quantity: 1 }] }, null)).status).toBe(401);
    const other = await customer();
    expect((await ask(o.orderNumber, { reason: 'MISSING_ITEM', items: [{ orderItemId: o.item, quantity: 1 }] }, other)).status).toBe(404);
    const late = await delivered({ hoursAgo: 49 });
    const w = await ask(late.orderNumber, { reason: 'MISSING_ITEM', items: [{ orderItemId: late.item, quantity: 1 }] });
    expect([w.status, w.body.error.code, w.body.error.message]).toEqual([422, 'RETURN_NOT_ALLOWED', 'Returns must be requested within 48 hours of delivery. Contact us and we’ll help.']);
    const inTransit = await delivered();
    await prisma.order.update({ where: { id: inTransit.orderId }, data: { fulfilmentStatus: 'SHIPPED' } });
    expect((await ask(inTransit.orderNumber, { reason: 'MISSING_ITEM', items: [{ orderItemId: inTransit.item, quantity: 1 }] })).body.error.details).toEqual({ reason: 'state' });
    expect(await prisma.returnRequest.count({ where: { orderId: { in: [o.orderId, late.orderId, inTransit.orderId] } } })).toBe(0);
  });

  it('photos: another order’s, someone else’s, still processing or already used → refused; nothing changes', async () => {
    const o = await delivered(), x = await delivered();
    const req = (mediaIds: number[]) => ask(o.orderNumber, { reason: 'DAMAGED', items: [{ orderItemId: o.item, quantity: 1 }], mediaIds });
    for (const id of [await photo(x.orderId), await photo(o.orderId, null), await photo(o.orderId, ME.id, 'PROCESSING')]) {
      const r = await req([id]);
      expect([r.status, r.body.error.details]).toEqual([422, { reason: 'media' }]);
    }
    const good = await photo(o.orderId);
    expect((await req([good])).status).toBe(201);
    expect((await req([good])).body.error.details).toEqual({ reason: 'media' });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.orderId }, select: { items: { select: { returnRequestedQty: true } } } })).toEqual({ items: [{ returnRequestedQty: 1 }] });
  });

  it('acceptance: duplicate / excess quantities are refused, also under concurrency (8 requests of 1 for 3 units → 3)', async () => {
    const o = await delivered();
    expect(fields(await ask(o.orderNumber, { reason: 'MISSING_ITEM', items: [{ orderItemId: o.item, quantity: 4 }] }))).toEqual({ 'items.0.quantity': 'That’s more than is left to return for this item (other return requests count too)' });
    const results = await Promise.all(Array.from({ length: 8 }, () => ask(o.orderNumber, { reason: 'MISSING_ITEM', items: [{ orderItemId: o.item, quantity: 1 }] })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status !== 201).every((r) => r.status === 400 && fields(r)['items.0.quantity'])).toBe(true);
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: o.item } })).returnRequestedQty).toBe(3);
  });

  it('photo upload: presign (images only) and complete for the owner; 404 for someone else’s order', async () => {
    const o = await delivered();
    const presign = (body: object, who = ME) => request(app).post(`/v1/me/orders/${o.orderNumber}/uploads/presign`).set('Origin', WEB).set('Authorization', `Bearer ${who.token}`).send(body);
    expect((await presign({ filename: 'a.pdf', contentType: 'application/pdf', size: 100 })).body.error.code).toBe('MEDIA_TYPE_NOT_ALLOWED');
    expect((await presign({ filename: 'a.jpg', contentType: 'image/jpeg', size: 9 * 1024 * 1024 })).body.error.code).toBe('MEDIA_TOO_LARGE');
    expect((await presign({ filename: 'a.jpg', contentType: 'image/jpeg', size: 100 }, await customer())).status).toBe(404);
    const ok = await presign({ filename: 'a.jpg', contentType: 'image/jpeg', size: 100 });
    expect(ok.status).toBe(201);
    const m = await prisma.media.findUniqueOrThrow({ where: { id: ok.body.media.id } });
    expect([m.visibility, m.ownerScope, m.uploadedBy]).toEqual(['PRIVATE', `return:${o.orderId}`, ME.id]);
    store.upload('priv', m.key, Buffer.alloc(100), 'image/jpeg');
    const done = await request(app).post(`/v1/me/orders/${o.orderNumber}/uploads/${m.id}/complete`).set('Origin', WEB).set('Authorization', `Bearer ${ME.token}`).send({});
    expect([done.status, done.body.media.status]).toEqual([200, 'UPLOADED']);
  });
});

describe('staff workflow', () => {
  async function requested(reason = 'DAMAGED', qty = 2) {
    const o = await delivered();
    const res = await ask(o.orderNumber, { reason, items: [{ orderItemId: o.item, quantity: qty }], mediaIds: reason === 'MISSING_ITEM' ? [] : [await photo(o.orderId)] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { ...o, returnId: res.body.id as number };
  }

  it('decide (partial) → in transit → receive → inspect (restock once) → refund (step-up, bounded, replay) → close; emails and audit', async () => {
    const o = await requested();
    const list = await get('/returns?open=1');
    expect(list.body.data.find((r: { id: number }) => r.id === o.returnId)).toMatchObject({ orderNumber: o.orderNumber, status: 'REQUESTED', units: 2, actions: ['decide', 'cancel'] });
    const d0 = (await get(`/returns/${o.returnId}`, STAFF)).body;
    expect(d0.photos).toEqual([{ id: expect.any(Number), url: expect.stringMatching(/^https:\/\/storage\.test\/priv\//), thumbUrl: expect.stringContaining('w320.webp') }]);
    expect((await post(`/returns/${o.returnId}/decide`, { decision: 'APPROVE', items: [{ orderItemId: o.item, approvedQty: 1 }] }, STAFF)).status).toBe(403);

    expect(fields(await post(`/returns/${o.returnId}/decide`, { decision: 'APPROVE', items: [{ orderItemId: o.item, approvedQty: 3 }] }))).toEqual({ 'items.0.approvedQty': 'Approve between 0 and the units requested' });
    const dec = await post(`/returns/${o.returnId}/decide`, { decision: 'APPROVE', items: [{ orderItemId: o.item, approvedQty: 1 }], note: 'One frame is fine' });
    expect([dec.status, dec.body.status, dec.body.items[0].approvedQty, dec.body.actions]).toEqual([200, 'APPROVED', 1, ['in-transit', 'receive', 'cancel']]);
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: o.item } })).returnRequestedQty).toBe(1);
    expect((await post(`/returns/${o.returnId}/decide`, { decision: 'REJECT', note: 'too late' })).body.error.code).toBe('INVALID_TRANSITION');
    const approved = (await emails(o.orderNumber, 'return.status_changed')).at(-1);
    expect([approved!.subject, approved!.text.includes('Approved: 1 × n (l)'), approved!.text.includes('One frame is fine')]).toEqual([`Return approved for order ${o.orderNumber}`, true, true]);

    expect((await post(`/returns/${o.returnId}/in-transit`, {}, STAFF)).body.status).toBe('IN_TRANSIT');
    expect(fields(await post(`/returns/${o.returnId}/receive`, { items: [{ orderItemId: o.item, receivedQty: 2 }] }, STAFF))).toEqual({ 'items.0.receivedQty': 'Enter between 0 and the units approved' });
    expect((await post(`/returns/${o.returnId}/receive`, { items: [{ orderItemId: o.item, receivedQty: 1 }] }, STAFF)).body.status).toBe('RECEIVED');
    expect(fields(await post(`/returns/${o.returnId}/inspect`, { items: [{ orderItemId: o.item, sellableQty: 1, damagedQty: 1 }] }, STAFF))).toEqual({ 'items.0.sellableQty': 'Sellable and damaged units must add up to the units received' });
    const before = await stock();
    const insp = await Promise.all([1, 2, 3].map(() => post(`/returns/${o.returnId}/inspect`, { items: [{ orderItemId: o.item, sellableQty: 1, damagedQty: 0 }] }, STAFF)));
    expect(insp.map((r) => r.status).sort()).toEqual([200, 422, 422]);
    expect(await stock()).toBe(before + 1);
    expect(await prisma.inventoryMovement.count({ where: { returnRequestId: o.returnId, reason: 'RETURN_RESTOCK' } })).toBe(1);

    const d1 = (await get(`/returns/${o.returnId}`)).body;
    expect(d1.items[0]).toMatchObject({ receivedQty: 1, sellableQty: 1, refundableQty: 1, refundableAmount: 50_000 });
    expect(d1.actions).toEqual(['refund', 'close']);
    const rf = (body: object, key = randomUUID()) => post(`/returns/${o.returnId}/refund`, { reason: 'Damaged in transit', ...body }, ADMIN, key);
    stepUp = false;
    expect((await rf({ items: [{ orderItemId: o.item, quantity: 1, amount: 50_000 }] })).body.error.code).toBe('STEP_UP_REQUIRED');
    stepUp = true;
    expect((await post(`/returns/${o.returnId}/refund`, { reason: 'x1x', items: [{ orderItemId: o.item, quantity: 1, amount: 50_000 }] }, STAFF, randomUUID())).status).toBe(403);
    expect(fields(await rf({ items: [{ orderItemId: o.item, quantity: 1, amount: 50_001 }] }))).toEqual({ 'items.0.amount': 'More than this return allows for the item (units received, and their share of the price)' });
    expect(fields(await rf({ items: [{ orderItemId: o.item, quantity: 2, amount: 50_000 }] }))).toHaveProperty('items.0.amount');
    const key = randomUUID();
    const ok = await rf({ items: [{ orderItemId: o.item, quantity: 1, amount: 50_000 }], shippingAmount: 7000 }, key);
    expect([ok.status, ok.body.method]).toEqual([201, 'ORIGINAL_PAYMENT']);
    const replay = await rf({ items: [{ orderItemId: o.item, quantity: 1, amount: 50_000 }], shippingAmount: 7000 }, key);
    expect([replay.headers['idempotent-replayed'], replay.body.refundId]).toEqual(['true', ok.body.refundId]);
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: ok.body.refundId }, select: { kind: true, amount: true, returnRequestId: true } })).toEqual({ kind: 'RETURN', amount: 57_000, returnRequestId: o.returnId });
    expect((await rf({ items: [{ orderItemId: o.item, quantity: 1, amount: 100 }] })).status).toBe(400);

    const d2 = (await get(`/returns/${o.returnId}`)).body;
    expect([d2.status, d2.items[0].refundableQty, d2.actions, d2.refunds.length]).toEqual(['REFUNDED', 0, ['close'], 1]);
    expect((await post(`/returns/${o.returnId}/close`, {}, STAFF)).status).toBe(403);
    expect((await post(`/returns/${o.returnId}/close`, { note: 'Refunded' })).body.status).toBe('CLOSED');
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.orderId }, select: { returnStatus: true } })).toEqual({ returnStatus: 'CLOSED' });
    const order = (await get(`/orders/${o.orderId}`)).body;
    expect(order.returns).toEqual([{ id: o.returnId, reason: 'DAMAGED', status: 'CLOSED', units: 2, createdAt: expect.any(String) }]);
    expect(order.history.filter((h: { dimension: string }) => h.dimension === 'RETURN').map((h: { to: string }) => h.to)).toEqual(['OPEN', 'CLOSED']);
    const actions = (await prisma.auditLog.findMany({ where: { entity: 'return', entityId: String(o.returnId) }, orderBy: { id: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(['return.decide', 'return.in_transit', 'return.receive', 'return.inspect', 'return.close']);
    expect(missingAudit).toEqual([]);
  });

  it('reject needs a reason for the customer, releases the units and emails it', async () => {
    const o = await requested();
    expect(fields(await post(`/returns/${o.returnId}/decide`, { decision: 'REJECT' }))).toEqual({ note: 'Tell the customer why (sent in the email)' });
    expect((await post(`/returns/${o.returnId}/decide`, { decision: 'REJECT', note: 'The photo shows wear from use' })).body.status).toBe('REJECTED');
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: o.item } })).returnRequestedQty).toBe(0);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.orderId }, select: { returnStatus: true } })).toEqual({ returnStatus: 'CLOSED' });
    const sent = await emails(o.orderNumber, 'return.status_changed');
    expect(sent.at(-1)!.text).toContain('Why: The photo shows wear from use');
  });

  it('missing item: approve → refund without receiving (COD: bank transfer) → close; nothing restocked', async () => {
    const o = await delivered({ method: 'COD' });
    const res = await ask(o.orderNumber, { reason: 'MISSING_ITEM', items: [{ orderItemId: o.item, quantity: 1 }] });
    const id = res.body.id as number;
    await post(`/returns/${id}/decide`, { decision: 'APPROVE', items: [{ orderItemId: o.item, approvedQty: 1 }] });
    expect((await post(`/returns/${id}/receive`, { items: [{ orderItemId: o.item, receivedQty: 1 }] })).body.error.details).toEqual({ reason: 'missing_item' });
    const before = await stock();
    const r = await post(`/returns/${id}/refund`, { reason: 'Never arrived', items: [{ orderItemId: o.item, quantity: 1, amount: 50_000 }] }, ADMIN, randomUUID());
    expect([r.status, r.body.method]).toEqual([201, 'MANUAL_BANK']);
    expect(await stock()).toBe(before);
    expect((await post(`/returns/${id}/close`, {})).body.status).toBe('CLOSED');
  });

  it('cancel before receipt (with a reason) releases the units; not after receipt; unknown return 404', async () => {
    const o = await requested('DAMAGED', 3);
    expect(fields(await post(`/returns/${o.returnId}/cancel`, {}))).toEqual({ note: 'Say why the return is cancelled' });
    expect((await post(`/returns/${o.returnId}/cancel`, { note: 'Customer decided to keep it' })).body.status).toBe('CANCELLED');
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: o.item } })).returnRequestedQty).toBe(0);
    const p = await requested('DAMAGED', 1);
    await post(`/returns/${p.returnId}/decide`, { decision: 'APPROVE', items: [{ orderItemId: p.item, approvedQty: 1 }] });
    await post(`/returns/${p.returnId}/receive`, { items: [{ orderItemId: p.item, receivedQty: 1 }] });
    expect((await post(`/returns/${p.returnId}/cancel`, { note: 'too late now' })).body.error.code).toBe('INVALID_TRANSITION');
    expect((await get('/returns/999999')).status).toBe(404);
    expect((await post('/returns/999999/close', {})).status).toBe(404);
    expect((await get(`/returns?status=CANCELLED&orderId=${o.orderId}`)).body.data.map((r: { id: number }) => r.id)).toEqual([o.returnId]);
  });
});
