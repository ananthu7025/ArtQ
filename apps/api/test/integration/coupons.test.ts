// Task 4.3: coupons on real PostgreSQL + Redis. Admin module (coupons:write; shared couponBody; discount frozen once
// used; soft delete; redemptions), the cart's coupon (every refusal in product.md §8.4 order, a coupon that stops and
// starts qualifying again, free shipping, public list), the per-customer and first-order checks, and the apply limit.
import type { PrismaClient, UserRole } from '@prisma/client';
import type { Express } from 'express';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdminRouter } from '../../src/admin/router.js';
import { createApp } from '../../src/app.js';
import { adminAuthRouter } from '../../src/auth/admin-routes.js';
import { cookieSpec } from '../../src/auth/cookies.js';
import { AuthService, DEFAULT_AUTH_TIMINGS } from '../../src/auth/service.js';
import { RedisSessionCache } from '../../src/auth/session-cache.js';
import { cartRouter } from '../../src/cart/routes.js';
import { registerCouponRoutes } from '../../src/coupons/admin-routes.js';
import { CouponService } from '../../src/coupons/service.js';
import * as fn from '../../src/db/functions.js';
import { hashPassword } from '../../src/lib/password.js';
import type { RateLimiter } from '../../src/middleware/rateLimit.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { order, tx, uniq } from '../helpers/fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';
import { liveProduct, type LiveProduct } from '../helpers/storefront-fixtures.js';

const ADMIN_ORIGIN = 'http://localhost:5173';
const WEB = 'http://localhost:3000';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const PASSWORD = 'coupon-password-123';
const CART = cookieSpec('cart', 'test').name;
const NO_LIMIT: RateLimiter = { hit: async () => ({ count: 0, resetMs: 60_000 }) };
/** A real counting limiter for the apply limit (fixed window, in memory). */
const hits = new Map<string, number>();
const COUNTING: RateLimiter = { hit: async (key) => { const n = (hits.get(key) ?? 0) + 1; hits.set(key, n); return { count: n, resetMs: 60_000 }; } };

let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express, limited: Express;
const missingAudit: string[] = [];
let ADMIN: { id: number; token: string }, STAFF: { id: number; token: string };

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  const cache = new RedisSessionCache(redis);
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: WEB, adminUrl: ADMIN_ORIGIN });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log: pino({ level: 'silent' }), hasRecentStepUp: (sid) => service.hasRecentStepUp(sid), onMissingAudit: (req) => missingAudit.push(`${req.method} ${req.originalUrl}`) });
  registerCouponRoutes(admin, prisma);
  const opts = { version: 't', origins: { storefront: [WEB], admin: [ADMIN_ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} } };
  app = createApp({ ...opts, routes: [adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }), admin.router, cartRouter({ ...deps, env: 'test', mediaUrl: (k) => k })] });
  limited = createApp({ ...opts, routes: [cartRouter({ ...deps, env: 'test', mediaUrl: (k) => k, limiter: COUNTING })] });
  [ADMIN, STAFF] = [await login('ADMIN'), await login('STAFF')];
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });

async function login(role: UserRole) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  const u = await prisma.user.create({ data: { email, name: role, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword(PASSWORD) } });
  const res = await request(app).post('/v1/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email, password: PASSWORD });
  return { id: u.id, token: res.body.accessToken as string };
}
const adminCall = (method: 'get' | 'post' | 'put' | 'delete', path: string, body?: object, who: { token: string } | null = ADMIN) => {
  let r = request(app)[method](`/v1/admin${path}`).set('Origin', ADMIN_ORIGIN);
  if (who) r = r.set('Authorization', `Bearer ${who.token}`);
  return body ? r.send(body) : r;
};
const code = () => `T${uniq().toUpperCase()}`.slice(0, 20);
const base = (o: object = {}) => ({ code: code(), title: '10% off', type: 'PERCENT', value: 10, ...o });
const create = async (o: object = {}) => {
  const res = await adminCall('post', '/coupons', base(o));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: number; code: string };
};
const fieldErrors = (res: request.Response) => Object.fromEntries((res.body.error?.details ?? []).map((d: { path: string; message: string }) => [d.path, d.message]));

/** A guest cart holding `qty` of the product's first variant; returns the cookie. */
async function cartWith(p: LiveProduct, qty = 1, a: Express = app) {
  const res = await request(a).post('/v1/cart/items').set('Origin', WEB).send({ variantId: p.variantIds[0], quantity: qty });
  expect(res.status).toBe(201);
  return `${CART}=${String(([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${CART}=`))).slice(CART.length + 1).split(';')[0]}`;
}
const cartCall = (method: 'get' | 'post' | 'patch' | 'delete', path: string, cookie?: string, body?: object, a: Express = app) => {
  let r = request(a)[method](`/v1${path}`).set('Origin', WEB);
  if (cookie) r = r.set('Cookie', cookie);
  return body ? r.send(body) : r;
};
const apply = (cookie: string | undefined, c: string) => cartCall('post', '/cart/coupon', cookie, { code: c });

describe('admin: access and validation (shared couponBody)', () => {
  it('needs coupons:write: STAFF → 403, no token → 401', async () => {
    expect((await adminCall('get', '/coupons', undefined, STAFF)).status).toBe(403);
    expect((await adminCall('post', '/coupons', base(), STAFF)).status).toBe(403);
    expect((await adminCall('get', '/coupons', undefined, null)).status).toBe(401);
  });

  it('create: the code is stored in capitals; defaults (1 use per customer, all products, active); audited', async () => {
    const c = code().toLowerCase();
    const res = await adminCall('post', '/coupons', { code: ` ${c} `, title: 'Welcome', type: 'FLAT', value: 15_000 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code: c.toUpperCase(), type: 'FLAT', value: 15_000, usageLimitPerCustomer: 1, usageLimitTotal: null, appliesTo: 'ALL', isActive: true, isPublic: false, state: 'active', hasRedemptions: false });
    expect(await prisma.auditLog.count({ where: { action: 'coupon.create', entityId: String(res.body.id) } })).toBe(1);
  });

  it('empty body → every required field on its field', async () => {
    const res = await adminCall('post', '/coupons', {});
    expect(res.status).toBe(400);
    expect(fieldErrors(res)).toMatchObject({ code: 'Enter a coupon code', title: 'Enter a title customers will see', type: 'Choose a discount type', value: 'Enter the discount' });
  });

  it.each([
    [{ type: 'PERCENT', value: 100 }, null], [{ type: 'PERCENT', value: 101 }, ['value', 'Use a percentage from 1 to 100']], [{ type: 'PERCENT', value: 0 }, ['value', 'Use a percentage from 1 to 100']],
    [{ type: 'FLAT', value: 100 }, null], [{ type: 'FLAT', value: 99 }, ['value', 'Use at least ₹1']],
    [{ type: 'FREE_SHIPPING', value: 0 }, null], [{ type: 'FREE_SHIPPING', value: 1 }, ['value', 'Free shipping has no discount value']],
    [{ type: 'FLAT', value: 500, maxDiscount: 100 }, ['maxDiscount', 'Only a percentage discount has a maximum']],
    [{ maxDiscount: 99 }, ['maxDiscount', 'Use at least ₹1']],
    [{ code: 'ABC' }, null], [{ code: 'AB' }, ['code', 'Use at least 3 characters']], [{ code: 'A'.repeat(30) }, null], [{ code: 'A'.repeat(31) }, ['code', 'Use at most 30 characters']],
    [{ code: 'NEW YEAR' }, ['code', 'Use letters, numbers, - or _']], [{ title: 'x'.repeat(120) }, null], [{ title: 'x'.repeat(121) }, ['title', 'Use at most 120 characters']],
    [{ startsAt: '2026-11-02T00:00:00+05:30', endsAt: '2026-11-01T00:00:00+05:30' }, ['endsAt', 'End after the start']],
    [{ usageLimitTotal: 0 }, ['usageLimitTotal', 'Use 1 or more']], [{ usageLimitPerCustomer: null }, null],
    [{ appliesTo: 'TYPES' }, ['targetIds', 'Choose at least one']], [{ targetIds: [1] }, ['targetIds', 'Remove the items, or choose what the coupon applies to']],
    [{ appliesTo: 'PRODUCTS', targetIds: [999_999] }, ['targetIds', 'Some of these no longer exist. Choose again.']],
    [{ isPublic: 'yes' }, ['isPublic', expect.any(String)]], [{ reservedCount: 5 }, ['', expect.any(String)]],
  ])('%j → %j', async (o, err) => {
    const res = await adminCall('post', '/coupons', base(o as object));
    if (!err) { expect(res.status, JSON.stringify(res.body)).toBe(201); return; }
    expect(res.status).toBe(400);
    expect(fieldErrors(res)[err[0] as string]).toEqual(err[1]);
  });

  it('a code already used (any case, even by a deleted coupon) → on the code field', async () => {
    const c = await create();
    expect(fieldErrors(await adminCall('post', '/coupons', base({ code: c.code.toLowerCase() })))).toEqual({ code: 'Another coupon (or a deleted one) uses this code' });
    await adminCall('delete', `/coupons/${c.id}`);
    expect((await adminCall('post', '/coupons', base({ code: c.code }))).status).toBe(400);
  });
});

describe('admin: list, edit, delete, redemptions', () => {
  it('list by state and search, newest first, paged', async () => {
    const tag = `Q${uniq().toUpperCase()}`;
    const day = 86_400_000;
    const active = await create({ code: `${tag}A`, title: 'Active one' });
    const scheduled = await create({ code: `${tag}S`, startsAt: new Date(Date.now() + day).toISOString() });
    const expired = await create({ code: `${tag}E`, startsAt: new Date(Date.now() - 2 * day).toISOString(), endsAt: new Date(Date.now() - day).toISOString() });
    const inactive = await create({ code: `${tag}I`, isActive: false });
    const ids = async (q: string) => ((await adminCall('get', `/coupons?q=${tag}${q}`)).body.data as { id: number }[]).map((c) => c.id);
    expect(await ids('')).toEqual([inactive.id, expired.id, scheduled.id, active.id]);
    expect(await ids('&state=active')).toEqual([active.id]);
    expect(await ids('&state=scheduled')).toEqual([scheduled.id]);
    expect(await ids('&state=expired')).toEqual([expired.id]);
    expect(await ids('&state=inactive')).toEqual([inactive.id]);
    const page = await adminCall('get', `/coupons?q=${tag}&limit=3&page=2`);
    expect([page.body.data.length, page.body.meta]).toEqual([1, { page: 2, limit: 3, total: 4, totalPages: 2 }]);
    expect((await adminCall('get', '/coupons?state=soon')).status).toBe(400);
  });

  it('edit: anything before first use; once used the discount (type/value) is frozen, other fields still change; the total limit cannot go below uses', async () => {
    const p = await liveProduct(prisma);
    const c = await create({ usageLimitTotal: 5, appliesTo: 'PRODUCTS', targetIds: [p.productId] });
    const edited = await adminCall('put', `/coupons/${c.id}`, base({ code: c.code, value: 15, appliesTo: 'TYPES', targetIds: [p.typeId] }));
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ value: 15, appliesTo: 'TYPES', targets: [{ id: p.typeId, name: expect.any(String) }] });

    const o = await tx(prisma, (t) => order(t, { lines: [{ variantId: p.variantIds[0]!, qty: 1 }], couponDiscount: 100 }));
    await tx(prisma, (t) => fn.reserveCoupon(t, { orderId: o.orderId, couponId: c.id, userId: null, email: 'a@x.in', phone: null, discount: 100 }));
    expect((await adminCall('put', `/coupons/${c.id}`, base({ code: c.code, value: 20, appliesTo: 'TYPES', targetIds: [p.typeId] }))).body.error.code).toBe('COUPON_IN_USE');
    expect((await adminCall('put', `/coupons/${c.id}`, base({ code: c.code, type: 'FLAT', value: 1_500, appliesTo: 'TYPES', targetIds: [p.typeId] }))).status).toBe(409);
    expect(fieldErrors(await adminCall('put', `/coupons/${c.id}`, base({ code: c.code, value: 15, usageLimitTotal: 0, appliesTo: 'TYPES', targetIds: [p.typeId] })))).toEqual({ usageLimitTotal: 'Use 1 or more' });
    await prisma.coupon.update({ where: { id: c.id }, data: { redeemedCount: 1 } });   // one more use, so 2 are taken
    expect(fieldErrors(await adminCall('put', `/coupons/${c.id}`, base({ code: c.code, value: 15, usageLimitTotal: 1, appliesTo: 'TYPES', targetIds: [p.typeId] })))).toEqual({ usageLimitTotal: 'Use at least 2 (already used or held at checkout)' });
    const ok = await adminCall('put', `/coupons/${c.id}`, base({ code: c.code, title: 'New title', value: 15, usageLimitTotal: 2, appliesTo: 'TYPES', targetIds: [p.typeId] }));
    expect(ok.body).toMatchObject({ title: 'New title', usageLimitTotal: 2, hasRedemptions: true });
    expect((await adminCall('put', '/coupons/999999', base())).status).toBe(404);
    expect(missingAudit).toEqual([]);
  });

  it('redemptions: order, customer and status; delete stops the coupon at once (soft)', async () => {
    const p = await liveProduct(prisma);
    const c = await create();
    const o = await tx(prisma, (t) => order(t, { lines: [{ variantId: p.variantIds[0]!, qty: 1 }], couponDiscount: 100 }));
    await tx(prisma, (t) => fn.reserveCoupon(t, { orderId: o.orderId, couponId: c.id, userId: null, email: 'Buyer@x.in', phone: null, discount: 100 }));
    const r = await adminCall('get', `/coupons/${c.id}/redemptions`);
    expect(r.body.data).toEqual([expect.objectContaining({ status: 'RESERVED', overLimit: false, discount: 100, orderNumber: o.orderNumber, customer: { userId: null, email: 'Buyer@x.in' } })]);

    const cookie = await cartWith(p);
    expect((await apply(cookie, c.code)).status).toBe(200);
    expect((await adminCall('delete', `/coupons/${c.id}`)).status).toBe(200);
    expect((await adminCall('delete', `/coupons/${c.id}`)).status).toBe(404);
    expect((await adminCall('get', `/coupons/${c.id}`)).status).toBe(404);
    expect((await cartCall('get', '/cart', cookie)).body.coupon).toBeNull();          // gone from the cart too
    expect((await apply(cookie, c.code)).body.error.code).toBe('COUPON_INVALID');
    expect(await prisma.coupon.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ isActive: false, deletedAt: expect.any(Date) });
  });
});

describe('cart: applying a coupon (refusals in product.md §8.4 order)', () => {
  it('applies case-insensitively; 10% capped at the maximum; totals and savings include it; one coupon at a time', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 300_000 }] });
    const cookie = await cartWith(p);
    const c = await create({ value: 10, maxDiscount: 20_000 });
    const res = await apply(cookie, c.code.toLowerCase());
    expect(res.status).toBe(200);
    expect(res.body.coupon).toEqual({ code: c.code, title: '10% off', summary: '10% off, up to ₹200', type: 'PERCENT', applied: true, discount: 20_000, freeShipping: false, problem: null });
    expect(res.body.totals).toMatchObject({ subtotal: 300_000, couponDiscount: 20_000, total: 280_000, savings: 20_000 });
    const flat = await create({ type: 'FLAT', value: 5_000 });
    expect((await apply(cookie, flat.code)).body.coupon).toMatchObject({ code: flat.code, discount: 5_000 });
    const removed = await cartCall('delete', '/cart/coupon', cookie);
    expect([removed.body.coupon, removed.body.totals.total]).toEqual([null, 300_000]);
  });

  it('unknown, inactive, not started, expired, used up, minimum order, wrong items, empty cart: each with its code; the cart keeps its previous coupon', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 50_000 }] });
    const other = await liveProduct(prisma);
    const cookie = await cartWith(p);
    const good = await create({ type: 'FLAT', value: 1_000 });
    await apply(cookie, good.code);
    const day = 86_400_000;
    const cases: [object | string, string, string][] = [
      ['NOPE-NOT-A-CODE', 'COUPON_INVALID', 'This coupon code is not valid'],
      [{ isActive: false }, 'COUPON_INVALID', 'This coupon code is not valid'],
      [{ startsAt: new Date(Date.now() + day).toISOString() }, 'COUPON_INVALID', 'This coupon is not active yet'],
      [{ startsAt: new Date(Date.now() - 2 * day).toISOString(), endsAt: new Date(Date.now() - 1000).toISOString() }, 'COUPON_EXPIRED', 'This coupon has expired'],
      [{ minOrderValue: 60_000 }, 'COUPON_MIN_ORDER', 'Add ₹100 more of eligible items to use this coupon'],
      [{ appliesTo: 'PRODUCTS', targetIds: [other.productId] }, 'COUPON_NOT_ELIGIBLE', 'This coupon does not apply to the items in your cart'],
      [{ appliesTo: 'CATEGORIES', targetIds: [other.categoryId] }, 'COUPON_NOT_ELIGIBLE', 'This coupon does not apply to the items in your cart'],
    ];
    for (const [o, errCode, message] of cases) {
      const c = typeof o === 'string' ? o : (await create(o)).code;
      const res = await apply(cookie, c);
      expect([res.status, res.body.error.code, res.body.error.message], JSON.stringify(o)).toEqual([422, errCode, message]);
    }
    const used = await create({ usageLimitTotal: 1 });
    await prisma.coupon.update({ where: { code: used.code }, data: { redeemedCount: 1 } });
    expect((await apply(cookie, used.code)).body.error).toMatchObject({ code: 'COUPON_USAGE_EXCEEDED', message: 'This coupon has been fully used' });
    expect((await apply(cookie, (await create({ minOrderValue: 60_000 })).code)).body.error.details).toEqual({ shortBy: 10_000 });
    expect((await cartCall('get', '/cart', cookie)).body.coupon).toMatchObject({ code: good.code, applied: true });   // unchanged
    expect((await apply(undefined, good.code)).body.error).toMatchObject({ code: 'COUPON_NOT_ELIGIBLE', message: 'Add something to your cart to use a coupon' });
    expect((await apply(cookie, '')).status).toBe(400);
    expect((await apply(cookie, 'bad code!')).status).toBe(400);
  });

  it('scope: only eligible lines are discounted (type), and the minimum counts eligible items only', async () => {
    const a = await liveProduct(prisma, { variants: [{ price: 40_000 }] });
    const b = await liveProduct(prisma, { variants: [{ price: 90_000 }] });
    const cookie = await cartWith(a);
    await cartCall('post', '/cart/items', cookie, { variantId: b.variantIds[0], quantity: 1 });
    const c = await create({ value: 50, appliesTo: 'TYPES', targetIds: [a.typeId], minOrderValue: 40_000 });
    const res = await apply(cookie, c.code);
    expect(res.body.coupon.discount).toBe(20_000);                                      // 50% of the eligible ₹400 only
    expect(res.body.totals).toMatchObject({ subtotal: 130_000, total: 110_000 });
    const tooHigh = await create({ type: 'FLAT', value: 1_000, appliesTo: 'TYPES', targetIds: [a.typeId], minOrderValue: 40_001 });
    expect((await apply(cookie, tooHigh.code)).body.error.code).toBe('COUPON_MIN_ORDER');   // ₹1,300 in the cart, but ₹400 eligible
  });

  it('a coupon that stops qualifying stays on the cart with the reason and no discount, and applies again when the cart qualifies', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 30_000, onHand: 10 }] });
    const cookie = await cartWith(p, 2);
    const c = await create({ type: 'FLAT', value: 5_000, minOrderValue: 60_000 });
    expect((await apply(cookie, c.code)).body.coupon.applied).toBe(true);
    const itemId = (await cartCall('get', '/cart', cookie)).body.items[0].id;
    const less = await cartCall('patch', `/cart/items/${itemId}`, cookie, { quantity: 1 });
    expect(less.body.coupon).toMatchObject({ applied: false, discount: 0, problem: { code: 'COUPON_MIN_ORDER', message: 'Add ₹300 more of eligible items to use this coupon', shortBy: 30_000 } });
    expect(less.body.totals).toMatchObject({ couponDiscount: 0, total: 30_000 });
    const more = await cartCall('patch', `/cart/items/${itemId}`, cookie, { quantity: 2 });
    expect(more.body.coupon).toMatchObject({ applied: true, discount: 5_000, problem: null });
    await prisma.coupon.update({ where: { code: c.code }, data: { endsAt: new Date(Date.now() - 1000), startsAt: new Date(Date.now() - 86_400_000) } });
    expect((await cartCall('get', '/cart', cookie)).body.coupon).toMatchObject({ applied: false, problem: { code: 'COUPON_EXPIRED' } });
    await cartCall('delete', `/cart/items/${itemId}`, cookie);
    await prisma.coupon.update({ where: { code: c.code }, data: { endsAt: null } });
    expect((await cartCall('get', '/cart', cookie)).body.coupon).toMatchObject({ applied: false, problem: { code: 'COUPON_NOT_ELIGIBLE', message: 'Add something to your cart to use a coupon' } });
  });

  it('free shipping: no money off the items, shipping shown as free, nothing left to reach', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 20_000 }] });
    const cookie = await cartWith(p);
    const c = await create({ type: 'FREE_SHIPPING', value: 0, title: 'Free delivery' });
    const res = await apply(cookie, c.code);
    expect(res.body.coupon).toMatchObject({ applied: true, discount: 0, freeShipping: true, summary: 'Free shipping' });
    expect(res.body.totals).toMatchObject({ couponDiscount: 0, total: 20_000, shipping: { freeApplied: true }, freeShippingRemaining: 0 });
  });

  it('the free-shipping progress counts the coupon discount (subtotal − coupon ≥ threshold)', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 100_000 }] });
    const cookie = await cartWith(p);
    const plain = await cartCall('get', '/cart', cookie);
    expect(plain.body.totals).toMatchObject({ shipping: { freeApplied: true }, freeShippingRemaining: 0 });
    const res = await apply(cookie, (await create({ type: 'FLAT', value: 10_000 })).code);
    expect(res.body.totals).toMatchObject({ shipping: { freeApplied: false }, freeShippingRemaining: 10_000 });
  });

  it('applying is limited to 10 tries a minute per network (codes cannot be guessed)', async () => {
    const p = await liveProduct(prisma);
    const cookie = await cartWith(p, 1, limited);
    const codes = await Promise.all([0, 1].map(() => create()));
    for (let i = 0; i < 10; i++) expect((await cartCall('post', '/cart/coupon', cookie, { code: `GUESS${i}` }, limited)).status).toBe(422);
    const blocked = await cartCall('post', '/cart/coupon', cookie, { code: codes[0]!.code }, limited);
    expect([blocked.status, blocked.body.error.code]).toEqual([429, 'RATE_LIMITED']);
  });
});

describe('who is asking: per-customer limit and first order (account or email)', () => {
  const svc = () => new CouponService(prisma);
  it('per-customer: counts this customer\'s reserved/redeemed uses (not released, not over-limit); by account or by email', async () => {
    const p = await liveProduct(prisma);
    const user = await prisma.user.create({ data: { email: `c${uniq()}@x.in`, role: 'CUSTOMER', status: 'ACTIVE' } });
    const c = await create({ usageLimitPerCustomer: 1 });
    const coupon = (await svc().findByCode(c.code))!;
    expect(await svc().check(coupon, { userId: user.id, email: null })).toEqual({ ok: true });
    const o = await tx(prisma, (t) => order(t, { lines: [{ variantId: p.variantIds[0]!, qty: 1 }], couponDiscount: 100 }));
    await tx(prisma, (t) => fn.reserveCoupon(t, { orderId: o.orderId, couponId: c.id, userId: user.id, email: user.email, phone: null, discount: 100 }));
    expect(await svc().check(coupon, { userId: user.id, email: null })).toMatchObject({ ok: false, code: 'COUPON_USAGE_EXCEEDED', message: 'You have already used this coupon' });
    expect(await svc().check(coupon, { userId: null, email: user.email.toUpperCase() })).toMatchObject({ ok: false, code: 'COUPON_USAGE_EXCEEDED' });
    expect(await svc().check(coupon, { userId: null, email: null })).toEqual({ ok: true });              // a guest before checkout: checked at checkout
    await tx(prisma, (t) => fn.releaseUnpaidOrder(t, { orderId: o.orderId, newStatus: 'EXPIRED', reason: 'timeout', actor: 'SYSTEM' }));
    expect(await svc().check(coupon, { userId: user.id, email: null })).toEqual({ ok: true });            // a released use does not count
    const unlimited = (await svc().findByCode((await create({ usageLimitPerCustomer: null })).code))!;
    expect(await svc().check(unlimited, { userId: user.id, email: user.email })).toEqual({ ok: true });
  });

  it('first order only: an earlier placed order (account or same email) refuses it; expired or cancelled ones do not count', async () => {
    const p = await liveProduct(prisma);
    const email = `f${uniq()}@x.in`;
    const coupon = (await svc().findByCode((await create({ firstOrderOnly: true, usageLimitPerCustomer: null })).code))!;
    const o = await tx(prisma, (t) => order(t, { lines: [{ variantId: p.variantIds[0]!, qty: 1 }] }));
    await prisma.$executeRawUnsafe(`UPDATE orders SET contact_email=$2, status='EXPIRED' WHERE id=$1`, o.orderId, email);
    expect(await svc().check(coupon, { userId: null, email })).toEqual({ ok: true });
    await prisma.$executeRawUnsafe(`UPDATE orders SET status='PLACED' WHERE id=$1`, o.orderId);
    expect(await svc().check(coupon, { userId: null, email: email.toUpperCase() })).toMatchObject({ ok: false, code: 'COUPON_NOT_ELIGIBLE', message: 'This coupon is only for your first order' });

    const cookie = await cartWith(p);                                                    // the cart learns the email at checkout
    expect((await apply(cookie, coupon.code)).status).toBe(200);
    await prisma.cart.updateMany({ where: { couponId: coupon.id }, data: { contactEmail: email } });
    expect((await cartCall('get', '/cart', cookie)).body.coupon).toMatchObject({ applied: false, problem: { code: 'COUPON_NOT_ELIGIBLE' } });
  });
});

describe('public coupons (GET /cart/coupons)', () => {
  it('only public, live, not used up; each says whether this cart qualifies and why not', async () => {
    await prisma.coupon.updateMany({ where: { isPublic: true }, data: { isPublic: false } });   // only this test's coupons
    const p = await liveProduct(prisma, { variants: [{ price: 50_000 }] });
    const cookie = await cartWith(p);
    const ok = await create({ isPublic: true, title: 'For everyone' });
    const min = await create({ isPublic: true, type: 'FLAT', value: 5_000, minOrderValue: 80_000 });
    await create({ isPublic: false });
    await create({ isPublic: true, isActive: false });
    const full = await create({ isPublic: true, usageLimitTotal: 1 });
    await prisma.coupon.update({ where: { id: full.id }, data: { redeemedCount: 1 } });
    const res = await cartCall('get', '/cart/coupons', cookie);
    expect(res.body.data.map((c: { code: string; eligible: boolean; reason: string | null }) => [c.code, c.eligible, c.reason])).toEqual([
      [min.code, false, 'Add ₹300 more of eligible items to use this coupon'],
      [ok.code, true, null],
    ]);
    expect((await cartCall('get', '/cart/coupons')).body.data.every((c: { eligible: boolean; reason: string }) => !c.eligible && c.reason === 'Add something to your cart to use a coupon')).toBe(true);
  });
});
