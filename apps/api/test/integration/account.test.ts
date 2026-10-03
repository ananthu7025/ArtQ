// Task 4.2 (API): /v1/me account endpoints, the cart joining the account at sign-in (rest of 4.1), states and pincode
// lookups. Real PostgreSQL + Redis; emails read from the outbox like the auth tests.
import type { PrismaClient } from '@prisma/client';
import type { Express, Request } from 'express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountRouter } from '../../src/account/routes.js';
import { createApp } from '../../src/app.js';
import { cookieSpec } from '../../src/auth/cookies.js';
import { authRouter } from '../../src/auth/routes.js';
import { AuthService, DEFAULT_AUTH_TIMINGS } from '../../src/auth/service.js';
import { RedisSessionCache } from '../../src/auth/session-cache.js';
import { cartRouter, claimGuestCartOnSignIn } from '../../src/cart/routes.js';
import { runRetention } from '../../src/jobs/retention.js';
import type { RateLimiter } from '../../src/middleware/rateLimit.js';
import { storefrontRouter } from '../../src/storefront/routes.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { order as makeOrder, uniq } from '../helpers/fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';
import { liveProduct } from '../helpers/storefront-fixtures.js';

const ORIGIN = 'http://localhost:3000';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const RT = cookieSpec('refresh', 'test').name;
const CART = cookieSpec('cart', 'test').name;
const PASSWORD = 'correct-horse-9';
const NO_LIMIT: RateLimiter = { hit: async () => ({ count: 0, resetMs: 60_000 }) };
const CDN = (k: string) => `https://cdn.test/${k}`;

let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express;
let kerala: number, karnataka: number;
let signInHook: (req: Request, userId: number) => Promise<void>;

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  const cache = new RedisSessionCache(redis);
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: ORIGIN, adminUrl: 'http://localhost:5173' });
  const deps = { prisma, cache, jwt: JWT };
  const claim = claimGuestCartOnSignIn({ prisma, env: 'test', mediaUrl: CDN });
  signInHook = claim;
  app = createApp({ version: 't', origins: { storefront: [ORIGIN], admin: ['http://localhost:5173'] }, readiness: { database: async () => {}, redis: async () => {} }, routes: [
    authRouter({ ...deps, service, env: 'test', refreshMaxAgeS: DEFAULT_AUTH_TIMINGS.refreshIdleS, limiter: NO_LIMIT, onSignedIn: (req, id) => signInHook(req, id) }),
    cartRouter({ ...deps, env: 'test', mediaUrl: CDN }),
    accountRouter({ ...deps, service, env: 'test', mediaUrl: CDN }),
    storefrontRouter({ prisma, mediaUrl: CDN }),
  ] });
  const india = await prisma.country.create({ data: { iso2: 'IN', name: 'India', phoneCode: '+91' } });
  kerala = (await prisma.state.create({ data: { countryId: india.id, name: 'Kerala', code: 'KL', gstCode: '32' } })).id;
  karnataka = (await prisma.state.create({ data: { countryId: india.id, name: 'Karnataka', code: 'KA', gstCode: '29' } })).id;
  await prisma.state.create({ data: { countryId: india.id, name: 'Old State', code: 'OS', isActive: false } });
  await prisma.postalCode.create({ data: { pincode: '682011', officeName: 'ERNAKULAM H.O', district: 'ERNAKULAM', stateId: kerala } });
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });

// ── helpers ──
type Who = { email: string; userId: number; access: string; refresh: string };
const send = (method: 'post' | 'patch' | 'delete' | 'get', path: string, o: { body?: object; bearer?: string; cookies?: string[] } = {}) => {
  let r = request(app)[method](`/v1${path}`).set('Origin', ORIGIN);
  if (o.bearer) r = r.set('Authorization', `Bearer ${o.bearer}`);
  if (o.cookies?.length) r = r.set('Cookie', o.cookies.join('; '));
  return o.body ? r.send(o.body) : r;
};
const cookieOf = (res: request.Response, name: string) => ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`));
const valueOf = (res: request.Response, name: string) => cookieOf(res, name)?.slice(name.length + 1).split(';')[0] ?? null;
async function lastMail(to: string, template: string) {
  const rows = await prisma.$queryRaw<{ payload: { data: Record<string, unknown> } }[]>`
    SELECT payload FROM outbox_events WHERE event_type = 'email.auth' AND payload->>'to' = ${to} AND payload->>'template' = ${template} ORDER BY id DESC LIMIT 1`;
  return rows[0]?.payload ?? null;
}
async function account(email = `u${uniq()}@example.com`, password = PASSWORD, cookies: string[] = []): Promise<Who & { res: request.Response }> {
  expect((await send('post', '/auth/signup', { body: { name: 'Test', email, password, marketingOptIn: false } })).status).toBe(201);
  const res = await send('post', '/auth/signup/verify', { body: { email, code: String((await lastMail(email, 'otp'))!.data.code) }, cookies });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { email, userId: res.body.user.id, access: res.body.accessToken, refresh: valueOf(res, RT)!, res };
}
const login = (email: string, password = PASSWORD, cookies: string[] = []) => send('post', '/auth/login', { body: { email, password }, cookies });
const fieldError = (res: request.Response, path: string, message: string) => {
  expect(res.status, JSON.stringify(res.body)).toBe(400);
  expect(res.body.error.details).toContainEqual(expect.objectContaining({ path, message }));
};

describe('profile', () => {
  it('PATCH /me: name, phone (empty clears it), marketing choice; never cached', async () => {
    const a = await account();
    const res = await send('patch', '/me', { bearer: a.access, body: { name: '  Asha Menon ', phone: '+919847012345', marketingOptIn: true } });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body.user).toMatchObject({ name: 'Asha Menon', phone: '+919847012345', marketingOptIn: true });
    expect((await send('patch', '/me', { bearer: a.access, body: { name: 'Asha', phone: '' } })).body.user).toMatchObject({ phone: null, marketingOptIn: true });
  });
  it('validation (shared rule): empty name, bad phone, 121-character name, unknown keys; no token → 401', async () => {
    const a = await account();
    fieldError(await send('patch', '/me', { bearer: a.access, body: { name: ' ' } }), 'name', 'Enter a name');
    fieldError(await send('patch', '/me', { bearer: a.access, body: { name: 'A', phone: '12345' } }), 'phone', 'Enter a phone number of 10 to 14 digits');
    fieldError(await send('patch', '/me', { bearer: a.access, body: { name: 'x'.repeat(121) } }), 'name', 'Use at most 120 characters');
    expect((await send('patch', '/me', { bearer: a.access, body: { name: 'x'.repeat(120) } })).status).toBe(200);
    expect((await send('patch', '/me', { bearer: a.access, body: { name: 'A', email: 'x@y.in' } })).status).toBe(400);
    expect((await send('patch', '/me', { body: { name: 'A' } })).status).toBe(401);
  });
});

describe('password change', () => {
  it('wrong current password → on that field; same as before → on the new one; ok → logged out everywhere, new password works, email sent', async () => {
    const a = await account();
    fieldError(await send('post', '/me/password', { bearer: a.access, body: { currentPassword: 'nope-nope-1', newPassword: 'another-horse-9' } }), 'currentPassword', 'This password is not correct');
    fieldError(await send('post', '/me/password', { bearer: a.access, body: { currentPassword: PASSWORD, newPassword: PASSWORD } }), 'newPassword', 'Choose a password different from the current one');
    fieldError(await send('post', '/me/password', { bearer: a.access, body: { currentPassword: PASSWORD, newPassword: 'short1' } }), 'newPassword', 'Use at least 8 characters');
    const ok = await send('post', '/me/password', { bearer: a.access, body: { currentPassword: PASSWORD, newPassword: 'another-horse-9' } });
    expect(ok.status).toBe(200);
    expect(cookieOf(ok, RT)).toMatch(/Max-Age=0/);
    expect((await send('get', '/me', { bearer: a.access })).status).toBe(401);                    // this session is gone
    expect((await send('post', '/auth/refresh', { body: {}, cookies: [`${RT}=${a.refresh}`] })).status).toBe(401);
    expect((await login(a.email)).status).toBe(401);
    expect((await login(a.email, 'another-horse-9')).status).toBe(200);
    expect(await lastMail(a.email, 'password_changed')).not.toBeNull();
  });
  it('wrong passwords count towards the login lockout (5 → locked, 423)', async () => {
    const a = await account();
    for (let i = 0; i < 4; i++) expect((await send('post', '/me/password', { bearer: a.access, body: { currentPassword: `wrong-${i}-pass`, newPassword: 'another-horse-9' } })).status).toBe(400);
    const fifth = await send('post', '/me/password', { bearer: a.access, body: { currentPassword: 'wrong-5-pass', newPassword: 'another-horse-9' } });
    expect(fifth.status).toBe(423);
    expect(fifth.body.error.code).toBe('ACCOUNT_LOCKED');
  });
});

describe('email change', () => {
  it('code to the NEW address, notice to the old; the right code switches it, logs out everywhere; the new address logs in', async () => {
    const a = await account();
    const target = `new${uniq()}@example.com`;
    const req = await send('post', '/me/email/change', { bearer: a.access, body: { newEmail: target.toUpperCase(), password: PASSWORD } });
    expect(req.status).toBe(200);
    expect(req.body.otpSentTo).toMatch(/^n\*\*\*@example\.com$/);
    expect(await lastMail(a.email, 'email_change_requested')).not.toBeNull();
    const code = String((await lastMail(target, 'otp'))!.data.code);
    expect((await lastMail(target, 'otp'))!.data.purpose).toBe('EMAIL_CHANGE');
    expect((await send('post', '/me/email/verify', { bearer: a.access, body: { code: code === '000000' ? '111111' : '000000' } })).body.error.code).toBe('OTP_INVALID');
    const ok = await send('post', '/me/email/verify', { bearer: a.access, body: { code } });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, email: target });
    expect(cookieOf(ok, RT)).toMatch(/Max-Age=0/);
    expect((await send('get', '/me', { bearer: a.access })).status).toBe(401);
    expect((await login(target)).status).toBe(200);
    expect((await login(a.email)).status).toBe(401);
    expect(await lastMail(a.email, 'email_changed')).not.toBeNull();
  });
  it('refusals on the right field: wrong password, the same address, an address another account uses; no pending change → OTP_INVALID', async () => {
    const a = await account();
    const b = await account();
    fieldError(await send('post', '/me/email/change', { bearer: a.access, body: { newEmail: 'x@example.com', password: 'wrong-pass-1' } }), 'password', 'This password is not correct');
    fieldError(await send('post', '/me/email/change', { bearer: a.access, body: { newEmail: a.email, password: PASSWORD } }), 'newEmail', 'This is already your email address');
    fieldError(await send('post', '/me/email/change', { bearer: a.access, body: { newEmail: b.email, password: PASSWORD } }), 'newEmail', 'Another account uses this email address');
    fieldError(await send('post', '/me/email/change', { bearer: a.access, body: { newEmail: 'not-an-email', password: PASSWORD } }), 'newEmail', 'Enter a valid email address');
    expect((await send('post', '/me/email/verify', { bearer: a.access, body: { code: '123456' } })).body.error.code).toBe('OTP_INVALID');
  });
  it('the address was taken between the request and the code → 409, nothing changes', async () => {
    const a = await account();
    const target = `race${uniq()}@example.com`;
    await send('post', '/me/email/change', { bearer: a.access, body: { newEmail: target, password: PASSWORD } });
    const code = String((await lastMail(target, 'otp'))!.data.code);
    await account(target);                                                     // someone signs up with it meanwhile
    expect((await send('post', '/me/email/verify', { bearer: a.access, body: { code } })).body.error.code).toBe('EMAIL_TAKEN');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a.userId } })).email).toBe(a.email);
  });
});

describe('account deletion', () => {
  it('needs the password and the confirmation; then logged out, cannot log in, the email can sign up again; anonymised after 30 days, orders kept', async () => {
    const a = await account();
    fieldError(await send('delete', '/me', { bearer: a.access, body: { password: PASSWORD } }), 'confirm', 'Tick the box to confirm');
    fieldError(await send('delete', '/me', { bearer: a.access, body: { password: 'wrong-pass-1', confirm: true } }), 'password', 'This password is not correct');
    await send('post', '/me/addresses', { bearer: a.access, body: { fullName: 'Asha', phone: '+919847012345', line1: '12 MG Road', city: 'Kochi', stateId: kerala, pincode: '682011' } });
    const p = await liveProduct(prisma);
    await send('post', '/me/wishlist/toggle', { bearer: a.access, body: { productId: p.productId } });
    const o = await makeOrder(prisma, { lines: [{ variantId: p.variantIds[0]!, qty: 1 }], reserve: false });
    await prisma.order.update({ where: { id: o.orderId }, data: { userId: a.userId } });
    const ok = await send('delete', '/me', { bearer: a.access, body: { password: PASSWORD, confirm: true } });
    expect(ok.status).toBe(200);
    expect((await send('get', '/me', { bearer: a.access })).status).toBe(401);
    expect((await login(a.email)).status).toBe(401);
    expect(await lastMail(a.email, 'account_deleted')).not.toBeNull();
    await prisma.$executeRaw`UPDATE otp_codes SET created_at = now() - interval '2 hours' WHERE target = ${a.email}`;   // past the resend cooldown
    const again = await account(a.email);                                     // the address is free again: a new account
    expect(again.userId).not.toBe(a.userId);
    expect(await runRetention(prisma)).toMatchObject({ accountsAnonymised: 0 });   // not yet: 30 days
    await prisma.user.update({ where: { id: a.userId }, data: { deletedAt: new Date(Date.now() - 31 * 86_400_000) } });
    expect(await runRetention(prisma)).toMatchObject({ accountsAnonymised: 1 });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: a.userId } })).toMatchObject({ email: `deleted-${a.userId}@deleted.invalid`, name: null, phone: null, passwordHash: null });
    expect(await prisma.address.count({ where: { userId: a.userId } })).toBe(0);
    expect(await prisma.wishlistItem.count({ where: { userId: a.userId } })).toBe(0);
    expect(await prisma.order.count({ where: { id: o.orderId, userId: a.userId } })).toBe(1);
    expect(await runRetention(prisma)).toMatchObject({ accountsAnonymised: 0 });   // once
  });
});

describe('addresses', () => {
  const body = (o: object = {}) => ({ fullName: 'Asha Menon', phone: '+919847012345', line1: '12 MG Road', city: 'Kochi', stateId: kerala, pincode: '682011', ...o });

  it('the first is the default; a new default replaces it; deleting the default promotes the most recent; state named', async () => {
    const a = await account();
    const first = await send('post', '/me/addresses', { bearer: a.access, body: body({ label: 'HOME', line2: '  ', landmark: 'Near the park' }) });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ isDefault: true, line2: null, landmark: 'Near the park', state: { id: kerala, name: 'Kerala' } });
    const second = await send('post', '/me/addresses', { bearer: a.access, body: body({ label: 'WORK', line1: 'Infopark' }) });
    expect(second.body.isDefault).toBe(false);
    const third = await send('post', '/me/addresses', { bearer: a.access, body: body({ label: 'OTHER', line1: 'Mum', isDefault: true }) });
    expect(third.body.isDefault).toBe(true);
    let list = (await send('get', '/me/addresses', { bearer: a.access })).body.data as { id: number; isDefault: boolean }[];
    expect(list.filter((x) => x.isDefault).map((x) => x.id)).toEqual([third.body.id]);
    list = (await send('delete', `/me/addresses/${third.body.id}`, { bearer: a.access })).body.data;
    expect(list.filter((x) => x.isDefault)).toHaveLength(1);
    list = (await send('post', `/me/addresses/${first.body.id}/default`, { bearer: a.access })).body.data;
    expect(list[0]).toMatchObject({ id: first.body.id, isDefault: true });
    const edited = await send('patch', `/me/addresses/${second.body.id}`, { bearer: a.access, body: body({ label: 'WORK', line1: 'Infopark Phase 2' }) });
    expect(edited.body).toMatchObject({ line1: 'Infopark Phase 2', isDefault: false });
  });

  it('validation (shared rule) and place checks: empty fields, bad phone/pincode, a pincode of another state, an inactive state', async () => {
    const a = await account();
    const empty = await send('post', '/me/addresses', { bearer: a.access, body: { fullName: '', phone: '', line1: '', city: '', pincode: '' } });
    for (const [path, message] of [['fullName', 'Enter the name for delivery'], ['line1', 'Enter the house / building and street'], ['city', 'Enter the city or town'], ['stateId', 'Choose a state'], ['pincode', 'Enter a 6-digit pincode'], ['phone', 'Enter a phone number of 10 to 14 digits']]) {
      expect(empty.body.error.details).toContainEqual(expect.objectContaining({ path, message }));
    }
    fieldError(await send('post', '/me/addresses', { bearer: a.access, body: body({ stateId: karnataka }) }), 'pincode', 'This pincode is in Kerala');
    fieldError(await send('post', '/me/addresses', { bearer: a.access, body: body({ stateId: 999_999 }) }), 'stateId', 'Choose a state');
    fieldError(await send('post', '/me/addresses', { bearer: a.access, body: body({ fullName: 'x'.repeat(121) }) }), 'fullName', 'Use at most 120 characters');
    expect((await send('post', '/me/addresses', { bearer: a.access, body: body({ fullName: 'x'.repeat(120), stateId: karnataka, pincode: '560001' }) })).status).toBe(201);   // unknown pincode allowed
  });

  it('at most 10; two saves racing at 9 → one saved, one refused; another person\'s address → 404', async () => {
    const a = await account();
    const b = await account();
    for (let i = 0; i < 9; i++) expect((await send('post', '/me/addresses', { bearer: a.access, body: body({ line1: `House ${i}` }) })).status).toBe(201);
    const race = await Promise.all([0, 1].map((i) => send('post', '/me/addresses', { bearer: a.access, body: body({ line1: `Race ${i}` }) })));
    expect(race.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(race.find((r) => r.status === 422)!.body.error.code).toBe('ADDRESS_LIMIT');
    expect(await prisma.address.count({ where: { userId: a.userId } })).toBe(10);
    const mine = (await send('get', '/me/addresses', { bearer: a.access })).body.data[0].id as number;
    expect((await send('patch', `/me/addresses/${mine}`, { bearer: b.access, body: body() })).status).toBe(404);
    expect((await send('delete', `/me/addresses/${mine}`, { bearer: b.access })).status).toBe(404);
    expect((await send('post', `/me/addresses/${mine}/default`, { bearer: b.access })).status).toBe(404);
  });
});

describe('wishlist', () => {
  it('toggle saves and removes; cards only for live products; unknown product → 404', async () => {
    const a = await account();
    const live = await liveProduct(prisma, { name: 'Saved One' });
    const draft = await liveProduct(prisma, { name: 'Draft One', status: 'DRAFT' });
    expect((await send('post', '/me/wishlist/toggle', { bearer: a.access, body: { productId: live.productId } })).body).toMatchObject({ saved: true, productIds: [live.productId] });
    const both = await send('post', '/me/wishlist/toggle', { bearer: a.access, body: { productId: draft.productId } });
    expect(both.body.productIds).toEqual([draft.productId, live.productId]);
    expect(both.body.data.map((c: { name: string }) => c.name)).toEqual(['Saved One']);    // the draft is kept but not shown
    expect((await send('post', '/me/wishlist/toggle', { bearer: a.access, body: { productId: live.productId } })).body).toMatchObject({ saved: false, productIds: [draft.productId] });
    expect((await send('post', '/me/wishlist/toggle', { bearer: a.access, body: { productId: 999_999 } })).status).toBe(404);
  });
  it('merge (after login): duplicates once, unknown ids skipped; 100 at most (101 → 400); a new save past 100 drops the oldest', async () => {
    const a = await account();
    const p = await liveProduct(prisma);
    expect((await send('post', '/me/wishlist/merge', { bearer: a.access, body: { productIds: [p.productId, p.productId, 999_999] } })).body.productIds).toEqual([p.productId]);
    expect((await send('post', '/me/wishlist/merge', { bearer: a.access, body: { productIds: Array.from({ length: 101 }, (_, i) => i + 1) } })).status).toBe(400);
    const many = [];
    for (let i = 0; i < 100; i++) many.push((await liveProduct(prisma, { name: `W${i}` })).productId);
    expect((await send('post', '/me/wishlist/merge', { bearer: a.access, body: { productIds: many } })).body.productIds).toHaveLength(100);
    const extra = await liveProduct(prisma, { name: 'One more' });
    const after = await send('post', '/me/wishlist/toggle', { bearer: a.access, body: { productId: extra.productId } });
    expect(after.body.productIds).toHaveLength(100);
    expect(after.body.productIds[0]).toBe(extra.productId);
  });
});

describe('the cart joins the account at sign-in (rest of task 4.1)', () => {
  const addAsGuest = async (variantId: number, quantity: number, cookie?: string) => {
    const res = await send('post', '/cart/items', { body: { variantId, quantity }, cookies: cookie ? [cookie] : [] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return cookie ?? `${CART}=${valueOf(res, CART)}`;
  };

  it('no account cart yet: the guest cart becomes it; then every device sees it with the token; the cookie alone no longer opens it', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 10_000, onHand: 9 }] });
    const guest = await addAsGuest(p.variantIds[0]!, 2);
    const a = await account(undefined, PASSWORD, [guest]);                       // signup verify claims it
    const mine = await send('get', '/cart', { bearer: a.access });
    expect(mine.body.items.map((i: { quantity: number }) => i.quantity)).toEqual([2]);
    expect((await send('get', '/cart', { cookies: [guest] })).body.items).toEqual([]);   // a guest on this computer after logout sees nothing
    const other = await login(a.email);                                                   // another device
    expect((await send('get', '/cart', { bearer: other.body.accessToken })).body.items).toHaveLength(1);
    expect(await prisma.cart.count({ where: { userId: a.userId, status: 'ACTIVE' } })).toBe(1);
  });

  it('an existing account cart: guest lines are added (quantities summed, capped at stock); the guest cart is marked merged', async () => {
    const p = await liveProduct(prisma, { variants: [{ price: 10_000, onHand: 4 }, { price: 20_000, onHand: 9 }] });
    const a = await account();
    expect((await send('post', '/cart/items', { bearer: a.access, body: { variantId: p.variantIds[0], quantity: 2 } })).status).toBe(201);
    const guest = await addAsGuest(p.variantIds[0]!, 3);
    await addAsGuest(p.variantIds[1]!, 1, guest);
    expect((await login(a.email, PASSWORD, [guest])).status).toBe(200);
    const cart = await send('get', '/cart', { bearer: a.access });
    expect(cart.body.items.map((i: { variantId: number; quantity: number }) => [i.variantId, i.quantity])).toEqual([[p.variantIds[0], 4], [p.variantIds[1], 1]]);
    expect(await prisma.cart.count({ where: { userId: a.userId, status: 'ACTIVE' } })).toBe(1);
    expect(await prisma.cart.count({ where: { status: 'MERGED', items: { some: { variantId: p.variantIds[1] } } } })).toBe(1);
  });

  it('signed in without any cart: the first add creates the account cart; an invalid token → 401 (the client refreshes)', async () => {
    const p = await liveProduct(prisma);
    const a = await account();
    expect((await send('get', '/cart', { bearer: a.access })).body.items).toEqual([]);
    expect((await send('post', '/cart/items', { bearer: a.access, body: { variantId: p.variantIds[0] } })).status).toBe(201);
    expect(await prisma.cart.count({ where: { userId: a.userId } })).toBe(1);
    expect((await send('get', '/cart', { bearer: 'not.a.token' })).status).toBe(401);
  });

  it('a failure while merging never fails the sign-in', async () => {
    const a = await account();
    const before = signInHook;
    signInHook = async () => { throw new Error('database hiccup'); };
    try { expect((await login(a.email)).status).toBe(200); } finally { signInHook = before; }
  });
});

describe('checkout quote with a saved address (task 4.6)', () => {
  it('uses the address\'s pincode; another customer\'s address → 404', async () => {
    const a = await account();
    const b = await account();
    const p = await liveProduct(prisma);
    await send('post', '/cart/items', { bearer: a.access, body: { variantId: p.variantIds[0] } });
    const addr = await send('post', '/me/addresses', { bearer: a.access, body: { fullName: 'Asha', phone: '+919847012345', line1: '12 MG Road', city: 'Kochi', stateId: kerala, pincode: '682011' } });
    const q = await send('post', '/checkout/quote', { bearer: a.access, body: { shippingAddressId: addr.body.id } });
    expect(q.status).toBe(200);
    expect(q.body.cart.totals.shipping.pincode).toBe('682011');
    expect(q.body.cart.items).toHaveLength(1);
    expect((await send('post', '/checkout/quote', { bearer: b.access, body: { shippingAddressId: addr.body.id } })).status).toBe(404);
  });
});

describe('address helpers', () => {
  it('states: active Indian states by name, publicly cacheable; pincode → district and state, unknown → 404, malformed → 400', async () => {
    const s = await request(app).get('/v1/states');
    expect(s.headers['cache-control']).toBe('public, max-age=0, s-maxage=60, stale-while-revalidate=60');
    expect(s.body.data.map((x: { name: string }) => x.name)).toEqual(['Karnataka', 'Kerala']);
    expect((await request(app).get('/v1/pincodes/682011')).body).toEqual({ pincode: '682011', district: 'ERNAKULAM', state: { id: kerala, name: 'Kerala' } });
    expect((await request(app).get('/v1/pincodes/999999')).status).toBe(404);
    expect((await request(app).get('/v1/pincodes/09')).status).toBe(400);
  });
});
