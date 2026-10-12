// The acceptance harness (task 7.1): the storefront checkout, payment and webhook routes and the admin order and
// refund routes on one app, against real PostgreSQL + Redis and a stub Razorpay (FakeRazorpay) that each test can
// replace. Orders are made the way a customer makes them (cart → quote → initiate) and paid the way Razorpay reports
// it (signed webhooks, the browser's verify, the reconcilers); refunds go through the admin API.
import { createHmac, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import request from 'supertest';
import { expect } from 'vitest';
import { createAdminRouter } from '../../src/admin/router.js';
import { registerStaffRoutes } from '../../src/admin/staff-routes.js';
import { registerCatalogRoutes } from '../../src/catalog/routes.js';
import { CatalogService } from '../../src/catalog/service.js';
import { registerTaxonomyRoutes } from '../../src/catalog/taxonomy-routes.js';
import { registerInventoryRoutes } from '../../src/inventory/routes.js';
import { createApp } from '../../src/app.js';
import { adminAuthRouter } from '../../src/auth/admin-routes.js';
import { authRouter } from '../../src/auth/routes.js';
import { cookieSpec } from '../../src/auth/cookies.js';
import { AuthService, DEFAULT_AUTH_TIMINGS } from '../../src/auth/service.js';
import { RedisSessionCache } from '../../src/auth/session-cache.js';
import { cartRouter } from '../../src/cart/routes.js';
import { CartService } from '../../src/cart/service.js';
import { CheckoutService } from '../../src/checkout/initiate.js';
import { checkoutPaymentRouter } from '../../src/checkout/payment-routes.js';
import { hashPassword } from '../../src/lib/password.js';
import { registerOrderRoutes } from '../../src/orders/admin-routes.js';
import { customerOrderRouter, registerCancelRoutes } from '../../src/orders/cancel.js';
import { MediaService } from '../../src/media/service.js';
import { customerReturnRouter, registerReturnRoutes } from '../../src/returns/routes.js';
import { DispatchService } from '../../src/orders/dispatch.js';
import { FakeRazorpay, type PaymentProvider } from '../../src/payments/razorpay.js';
import { registerRefundRoutes } from '../../src/payments/refund-admin.js';
import { processRefundSend } from '../../src/payments/refunds.js';
import { razorpayHandlers } from '../../src/payments/webhook-handlers.js';
import { seedGeo, seedSettings, seedShipping } from '../../src/seed/steps.js';
import { processWebhook, webhookRouter } from '../../src/webhooks/inbox.js';
import { razorpayProvider } from '../../src/webhooks/provider.js';
import { createMigratedDatabase, type TestDb } from './db.js';
import { uniq } from './fixtures.js';
import { MemoryObjectStore } from './memory-store.js';
import { startPostgres, startRedis, type Service } from './services.js';
import { liveProduct, type LiveProduct } from './storefront-fixtures.js';

export const WEB = 'http://localhost:3000';
export const ADMIN_ORIGIN = 'http://localhost:5173';
const SECRET = 'whsec-acceptance-0123456789';
const CART = cookieSpec('cart', 'test').name;
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const NO_LIMIT = { hit: async () => ({ count: 0, resetMs: 60_000 }) };
const mediaUrl = (k: string) => `https://cdn.test/${k}`;
export const log = pino({ level: 'silent' });

export type AcceptanceApp = Awaited<ReturnType<typeof createAcceptanceApp>>;

export async function createAcceptanceApp() {
  const [pg, rd]: [Service, Service] = await Promise.all([startPostgres(), startRedis()]);
  const db: TestDb = await createMigratedDatabase(pg.url);
  const prisma: PrismaClient = db.prisma;
  const redis = new Redis(rd.url);
  await seedShipping(prisma); await seedGeo(prisma); await seedSettings(prisma);
  const kerala = (await prisma.state.findFirstOrThrow({ where: { name: 'Kerala' } })).id;
  await prisma.postalCode.create({ data: { pincode: '682011', officeName: 'ERNAKULAM H.O', district: 'ERNAKULAM', stateId: kerala } });

  const state = { fake: new FakeRazorpay(), stepUp: true };
  /** Always the current fake (tests swap it with `reset()`). */
  const provider = new Proxy({} as PaymentProvider, { get: (_t, k) => { const v = (state.fake as unknown as Record<string | symbol, unknown>)[k]; return typeof v === 'function' ? v.bind(state.fake) : v; } });
  const providers = () => [razorpayProvider(SECRET, razorpayHandlers(provider))];
  const checkout = new CheckoutService({ prisma, carts: new CartService(prisma, mediaUrl), provider, mediaUrl, storeName: 'ArtQ' });
  const cache = new RedisSessionCache(redis);
  const auth = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: WEB, adminUrl: ADMIN_ORIGIN });
  const admin = createAdminRouter({ prisma, cache, jwt: JWT, limiter: NO_LIMIT, log, hasRecentStepUp: async () => state.stepUp });
  registerOrderRoutes(admin, prisma, new DispatchService(prisma, { store: new MemoryObjectStore(), buckets: { PUBLIC: 'p', PRIVATE: 'q' } }));
  registerRefundRoutes(admin, prisma, log);
  registerCancelRoutes(admin, prisma, log);
  registerStaffRoutes(admin, prisma, auth);
  const media = new MediaService(prisma, { store: new MemoryObjectStore(), buckets: { PUBLIC: 'pub', PRIVATE: 'priv' }, publicBaseUrl: 'https://cdn.test' }, async () => {});
  registerReturnRoutes(admin, prisma, log, media);
  registerCatalogRoutes(admin, new CatalogService(prisma, (m) => media.view(m)));
  registerTaxonomyRoutes(admin, prisma, (m) => media.view(m));
  registerInventoryRoutes(admin, prisma);
  const app: Express = createApp({ version: 't', origins: { storefront: [WEB], admin: [ADMIN_ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [
      adminAuthRouter({ prisma, cache, jwt: JWT, service: auth, env: 'test', limiter: NO_LIMIT }),
      authRouter({ prisma, cache, jwt: JWT, service: auth, env: 'test', refreshMaxAgeS: DEFAULT_AUTH_TIMINGS.refreshIdleS, limiter: NO_LIMIT }),
      customerOrderRouter({ prisma, cache, jwt: JWT, log }),
      customerReturnRouter({ prisma, cache, jwt: JWT, log, media }),
      cartRouter({ prisma, cache, jwt: JWT, env: 'test', mediaUrl, checkout: { provider, storeName: 'ArtQ', log, lockSeconds: 1 } }),
      checkoutPaymentRouter({ prisma, cache, jwt: JWT, env: 'test', provider, log, checkout } as Parameters<typeof checkoutPaymentRouter>[0]),
      webhookRouter({ prisma, queue: { add: async () => undefined as never }, providers: providers(), log }),
      admin.router,
    ] } as Parameters<typeof createApp>[0]);

  const email = `owner${uniq()}@artq.in`;
  await prisma.user.create({ data: { email, name: 'Owner', role: 'SUPER_ADMIN', status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword('acceptance-pass-1') } });
  const ownerToken = (await request(app).post('/v1/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email, password: 'acceptance-pass-1' })).body.accessToken as string;

  const deps = () => ({ prisma, provider, checkout, log });

  /** A signed-in customer (storefront session). */
  async function customer(o: { role?: 'CUSTOMER' | 'STAFF' | 'ADMIN' | 'SUPER_ADMIN' } = {}) {
    const mail = `c${uniq()}@example.com`;
    const u = await prisma.user.create({ data: { email: mail, name: 'Hema', role: o.role ?? 'CUSTOMER', status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword('acceptance-pass-1') } });
    const res = await request(app).post('/v1/auth/login').set('Origin', WEB).send({ email: mail, password: 'acceptance-pass-1' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return { id: u.id, email: mail, token: res.body.accessToken as string };
  }
  /** The same person signed in to the admin (only for staff roles). */
  async function adminLogin(mail: string) {
    const res = await request(app).post('/v1/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: mail, password: 'acceptance-pass-1' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.accessToken as string;
  }

  /** A cart with one unit of a fresh product, priced for the Kochi pincode. */
  async function cartWith(o: { price?: number; onHand?: number; product?: LiveProduct; customer?: { token: string } } = {}) {
    const p = o.product ?? await liveProduct(prisma, { variants: [{ price: o.price ?? 120_000, onHand: o.onHand ?? 10 }] });
    const bearer: Record<string, string> = o.customer ? { Authorization: `Bearer ${o.customer.token}` } : {};
    const add = await request(app).post('/v1/cart/items').set('Origin', WEB).set(bearer).send({ variantId: p.variantIds[0] });
    const cookie = `${CART}=${String(([] as string[]).concat(add.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${CART}=`))).slice(CART.length + 1).split(';')[0]}`;
    const total = (await request(app).post('/v1/checkout/quote').set('Origin', WEB).set('Cookie', cookie).set(bearer).send({ pincode: '682011' })).body.cart.totals.total as number;
    const body = {
      contact: { email: `c${uniq()}@example.com`, phone: '9847012345' }, shippingAddress: { fullName: 'Hema R', phone: '9847012345', line1: '12 Rose Villa', city: 'Kochi', stateId: kerala, pincode: '682011' },
      paymentMethod: 'RAZORPAY', expectedTotal: total, acceptTerms: true,
    };
    /** POST /checkout/initiate for this cart with the given key (default: a new one). */
    const initiate = (key: string = randomUUID()) => request(app).post('/v1/checkout/initiate').set('Origin', WEB).set('Cookie', cookie).set(bearer).set('Idempotency-Key', key).send(body).then((r) => r);
    return { p, cookie, bearer, total, body, initiate };
  }

  /** A customer's prepaid order, initiated and awaiting payment (`attempts` > 1 makes extra payment attempts first). */
  async function pending(o: { price?: number; onHand?: number; product?: LiveProduct; attempts?: number; couponCode?: string; customer?: { token: string } } = {}) {
    const p = o.product ?? await liveProduct(prisma, { variants: [{ price: o.price ?? 120_000, onHand: o.onHand ?? 10 }] });
    const bearer = o.customer ? { Authorization: `Bearer ${o.customer.token}` } : {};
    const add = await request(app).post('/v1/cart/items').set('Origin', WEB).set(bearer).send({ variantId: p.variantIds[0] });
    const cookie = `${CART}=${String(([] as string[]).concat(add.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${CART}=`))).slice(CART.length + 1).split(';')[0]}`;
    if (o.couponCode) expect((await request(app).post('/v1/cart/coupon').set('Origin', WEB).set('Cookie', cookie).set(bearer).send({ code: o.couponCode })).status).toBe(200);
    const total = (await request(app).post('/v1/checkout/quote').set('Origin', WEB).set('Cookie', cookie).set(bearer).send({ pincode: '682011' })).body.cart.totals.total as number;
    const res = await request(app).post('/v1/checkout/initiate').set('Origin', WEB).set('Cookie', cookie).set(bearer).set('Idempotency-Key', randomUUID()).send({
      contact: { email: `c${uniq()}@example.com`, phone: '9847012345' }, shippingAddress: { fullName: 'Hema R', phone: '9847012345', line1: '12 Rose Villa', city: 'Kochi', stateId: kerala, pincode: '682011' },
      paymentMethod: 'RAZORPAY', expectedTotal: total, acceptTerms: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const orderNumber = res.body.orderNumber as string;
    for (let i = 1; i < (o.attempts ?? 1); i++) {
      const r = await request(app).post(`/v1/orders/${orderNumber}/payment/retry`).set('Origin', WEB).set('Cookie', cookie).set(bearer).set('Idempotency-Key', randomUUID()).send({ paymentMethod: 'RAZORPAY' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const orderId = (await prisma.order.findUniqueOrThrow({ where: { orderNumber } })).id;
    const attempts = (await prisma.paymentAttempt.findMany({ where: { orderId }, orderBy: { id: 'asc' } })).map((a) => a.providerOrderId!);
    return {
      p, cookie, orderNumber, orderId, total, providerOrderId: res.body.razorpay?.orderId as string, attempts,
      verify: (paymentId: string, providerOrderId = attempts.at(-1)!) => request(app).post('/v1/checkout/verify').set('Origin', WEB).set('Cookie', cookie).send({ orderNumber, razorpayPaymentId: paymentId, razorpaySignature: state.fake.sign(providerOrderId, paymentId) }),
    };
  }
  /**
   * A checkout that crashed after Razorpay created its order but before ArtQ saved the provider order id (TX2): the
   * attempt stays CREATING and only Razorpay knows the mapping.
   */
  async function crashedInitiate() {
    const p = await liveProduct(prisma, { variants: [{ price: 120_000, onHand: 10 }] });
    const add = await request(app).post('/v1/cart/items').set('Origin', WEB).send({ variantId: p.variantIds[0] });
    const cookie = `${CART}=${String(([] as string[]).concat(add.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${CART}=`))).slice(CART.length + 1).split(';')[0]}`;
    const total = (await request(app).post('/v1/checkout/quote').set('Origin', WEB).set('Cookie', cookie).send({ pincode: '682011' })).body.cart.totals.total as number;
    state.fake.next = ['created-then-crash'];
    const res = await request(app).post('/v1/checkout/initiate').set('Origin', WEB).set('Cookie', cookie).set('Idempotency-Key', randomUUID()).send({
      contact: { email: `c${uniq()}@example.com`, phone: '9847012345' }, shippingAddress: { fullName: 'Hema R', phone: '9847012345', line1: '12 Rose Villa', city: 'Kochi', stateId: kerala, pincode: '682011' },
      paymentMethod: 'RAZORPAY', expectedTotal: total, acceptTerms: true,
    });
    expect(res.status).toBe(500);
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { status: 'CREATING' }, orderBy: { id: 'desc' }, include: { order: true } });
    const providerOrderId = state.fake.orders.at(-1)!.id;
    const orderNumber = attempt.order.orderNumber;
    return {
      p, cookie, total, attempt, providerOrderId, orderNumber, orderId: attempt.orderId,
      verify: (paymentId: string) => request(app).post('/v1/checkout/verify').set('Origin', WEB).set('Cookie', cookie).send({ orderNumber, razorpayPaymentId: paymentId, razorpaySignature: state.fake.sign(providerOrderId, paymentId) }),
    };
  }
  const order = (orderNumber: string) => prisma.order.findUniqueOrThrow({ where: { orderNumber }, include: { payments: { orderBy: { id: 'asc' } }, paymentAttempts: { orderBy: { id: 'asc' } }, refunds: { orderBy: { id: 'asc' }, include: { attempts: { orderBy: { attemptNo: 'asc' } } } }, exceptions: true } });
  /** Razorpay delivers a signed webhook; returns the inbox row id. */
  async function hook(event: string, entity: { payment?: string; refund?: string }, eventId = `evt_${uniq()}`) {
    const body = JSON.stringify({ event, created_at: Math.floor(Date.now() / 1000), payload: { ...(entity.payment ? { payment: { entity: { id: entity.payment } } } : {}), ...(entity.refund ? { refund: { entity: { id: entity.refund } } } : {}) } });
    const res = await request(app).post('/v1/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-event-id', eventId).set('x-razorpay-signature', createHmac('sha256', SECRET).update(body).digest('hex')).send(body);
    expect(res.status).toBe(200);
    return (await prisma.webhookEvent.findFirstOrThrow({ where: { eventId } })).id;
  }
  /** One webhook worker run (`leaseS`/`renewMs` let a test make a worker stall past its lease). */
  const processEvent = (id: number, o: { leaseS?: number; renewMs?: number } = {}) => processWebhook({ prisma, providers: providers(), log, ...o }, id);
  /** A captured payment reported the usual way: webhook received and processed. */
  const captured = async (paymentId: string) => processEvent(await hook('payment.captured', { payment: paymentId }));

  const adminCall = (method: 'get' | 'post' | 'patch', path: string, body?: object, key: string | null = randomUUID()) => {
    const r = request(app)[method](`/v1/admin${path}`).set('Origin', ADMIN_ORIGIN).set('Authorization', `Bearer ${ownerToken}`);
    if (method === 'get') return r;
    return (method === 'post' && key ? r.set('Idempotency-Key', key) : r).send(body ?? {});
  };
  /** Staff ask for a refund (admin API); returns the response. */
  const askRefund = (orderId: number, body: object, key = randomUUID()) => adminCall('post', `/orders/${orderId}/refunds`, { kind: 'GOODWILL', reason: 'Acceptance refund', ...body }, key);
  /** Runs the refund.send consumer for this refund's pending deliveries. */
  async function sendRefund(refundId: number) {
    const rows = await prisma.$queryRaw<{ id: bigint }[]>`SELECT d.id FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id
      JOIN refund_attempts a ON a.id = (e.payload->>'refund_attempt_id')::int
      WHERE d.consumer = 'refund.send' AND d.status NOT IN ('COMPLETED', 'DEAD') AND a.refund_id = ${refundId} ORDER BY d.id`;
    const out: string[] = [];
    for (const r of rows) out.push(await processRefundSend({ prisma, provider, log }, Number(r.id)));
    return out;
  }
  const itemOf = async (orderId: number) => (await prisma.orderItem.findFirstOrThrow({ where: { orderId } })).id;

  return {
    app, prisma, redis, state, provider, deps, kerala,
    get fake() { return state.fake; },
    reset: () => { state.fake = new FakeRazorpay(); state.stepUp = true; },
    customer, adminLogin, ownerToken, cartWith, pending, crashedInitiate, order, hook, processEvent, captured, adminCall, askRefund, sendRefund, itemOf,
    close: async () => { redis.disconnect(); await db.drop(); await Promise.all([pg.stop(), rd.stop()]); },
  };
}
