// Task 1.4 customer auth over HTTP, real PostgreSQL (migrated) + real Redis session cache.
// ✅ AT-11 (API part): concurrent refresh inside the grace window never logs out; replay after the grace window revokes
// the session; reused token outside grace revokes the session; blocked user's next request → 401.
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { cookieSpec } from '../../src/auth/cookies.js';
import { authRouter } from '../../src/auth/routes.js';
import { AuthService, DEFAULT_AUTH_TIMINGS } from '../../src/auth/service.js';
import { MemorySessionCache, RedisSessionCache, type SessionCache } from '../../src/auth/session-cache.js';
import { randomToken, sha256, signAccessToken, signLink } from '../../src/auth/tokens.js';
import * as fn from '../../src/db/functions.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import type { RateLimiter } from '../../src/middleware/rateLimit.js';
import { order as makeOrder, catalog, tx, uniq } from '../helpers/fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const ORIGIN = 'http://localhost:3000';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const LINK_SECRET = 'test-link-secret-0123456789abcdef0123';
const COOKIE = cookieSpec('refresh', 'test').name;
const PASSWORD = 'correct-horse-9';
const NO_LIMIT: RateLimiter = { hit: async () => ({ count: 0, resetMs: 60_000 }) };

let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, cache: SessionCache, service: AuthService, app: Express;

function build(c: SessionCache): { app: Express; service: AuthService } {
  const s = new AuthService(prisma, c, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: LINK_SECRET, webUrl: ORIGIN, adminUrl: 'http://localhost:5173' });
  // Rate limits are exercised in rate-limit.test.ts; here they would only throttle the suite's own traffic.
  const a = createApp({ version: 't', origins: { storefront: [ORIGIN], admin: ['http://localhost:5173'] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [authRouter({ prisma, cache: c, jwt: JWT, service: s, env: 'test', refreshMaxAgeS: DEFAULT_AUTH_TIMINGS.refreshIdleS, limiter: NO_LIMIT })] });
  return { app: a, service: s };
}

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  cache = new RedisSessionCache(redis);
  ({ app, service } = build(cache));
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });

// ── helpers ─────────────────────────────────────────────────────────────────
const post = (path: string, body: object = {}, o: { cookie?: string; bearer?: string; origin?: string | null; a?: Express } = {}) => {
  let r = request(o.a ?? app).post(`/v1${path}`).set('Content-Type', 'application/json');
  if (o.origin !== null) r = r.set('Origin', o.origin ?? ORIGIN);
  if (o.cookie) r = r.set('Cookie', `${COOKIE}=${o.cookie}`);
  if (o.bearer) r = r.set('Authorization', `Bearer ${o.bearer}`);
  return r.send(body);
};
const me = (bearer: string, a = app) => request(a).get('/v1/me').set('Authorization', `Bearer ${bearer}`);
const setCookies = (res: request.Response): string[] => ([] as string[]).concat(res.headers['set-cookie'] ?? []);
const refreshCookie = (res: request.Response): string | null => {
  const c = setCookies(res).find((x) => x.startsWith(`${COOKIE}=`));
  return c ? c.slice(COOKIE.length + 1).split(';')[0]! : null;
};
const newEmail = () => `u${uniq()}@example.com`;

/** Latest auth email to `to` (the outbox row the email consumer will deliver). */
async function lastMail(to: string, template?: string) {
  const rows = await prisma.$queryRaw<{ payload: { template: string; to: string; data: Record<string, unknown> } }[]>`
    SELECT payload FROM outbox_events WHERE event_type = 'email.auth' AND payload->>'to' = ${to}
      AND (${template ?? null}::text IS NULL OR payload->>'template' = ${template ?? null}) ORDER BY id DESC LIMIT 1`;
  return rows[0]?.payload ?? null;
}
const mailCount = async (to: string, template: string) => (await prisma.$queryRaw<{ n: number }[]>`
  SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'email.auth' AND payload->>'to' = ${to} AND payload->>'template' = ${template}`)[0]!.n;
const otpOf = async (to: string) => String((await lastMail(to, 'otp'))!.data.code);

/** Signs up and verifies a fresh account; returns tokens. */
async function account(email = newEmail(), password = PASSWORD) {
  expect((await post('/auth/signup', { name: 'Test', email, password, marketingOptIn: false })).status).toBe(201);
  const res = await post('/auth/signup/verify', { email, code: await otpOf(email) });
  expect(res.status).toBe(200);
  return { email, userId: res.body.user.id as number, access: res.body.accessToken as string, refresh: refreshCookie(res)!, res };
}

// ── signup ──────────────────────────────────────────────────────────────────
describe('signup + email OTP', () => {
  it('creates a pending account, emails a code, verification activates it and issues tokens + a correct cookie', async () => {
    const email = newEmail();
    const res = await post('/auth/signup', { name: 'Asha', email: email.toUpperCase(), password: PASSWORD, marketingOptIn: true, phone: '+919800000000' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ otpSentTo: `${email[0]}***@example.com` });
    expect(await prisma.user.findFirst({ where: { email } })).toMatchObject({ status: 'PENDING_VERIFICATION', name: 'Asha', marketingOptIn: true, emailVerifiedAt: null });
    const v = await post('/auth/signup/verify', { email, code: await otpOf(email) });
    expect(v.status).toBe(200);
    expect(v.body.user).toMatchObject({ email, emailVerified: true, role: 'CUSTOMER', phone: '+919800000000' });
    expect(v.headers['cache-control']).toBe('private, no-store');   // architecture.md §6.1
    const c = setCookies(v).find((x) => x.startsWith(`${COOKIE}=`))!;
    expect(c).toMatch(/; Path=\/v1\/auth; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict$/);
    expect(c.toLowerCase()).not.toContain('domain');
    expect((await me(v.body.accessToken)).body.user.email).toBe(email);
    expect((await prisma.user.findFirstOrThrow({ where: { email } })).status).toBe('ACTIVE');
  });

  it('existing verified email: same response, no new account, password unchanged, owner is notified', async () => {
    const a = await account();
    const before = await prisma.user.findFirstOrThrow({ where: { email: a.email } });
    const res = await post('/auth/signup', { name: 'Mallory', email: a.email, password: 'attacker-pass-1', marketingOptIn: false });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ otpSentTo: `${a.email[0]}***@example.com` });
    expect(await prisma.user.count({ where: { email: a.email } })).toBe(1);
    expect((await prisma.user.findFirstOrThrow({ where: { email: a.email } })).passwordHash).toBe(before.passwordHash);
    expect(await mailCount(a.email, 'signup_attempt_existing')).toBe(1);
  });

  it('repeat signup while pending updates the details but respects the 30 s resend cooldown', async () => {
    const email = newEmail();
    await post('/auth/signup', { name: 'One', email, password: PASSWORD, marketingOptIn: false });
    await post('/auth/signup', { name: 'Two', email, password: PASSWORD, marketingOptIn: false });
    expect(await mailCount(email, 'otp')).toBe(1);
    expect((await prisma.user.findFirstOrThrow({ where: { email } })).name).toBe('Two');
  });

  it('wrong codes count; after 5 attempts even the right code fails; expired codes report OTP_EXPIRED', async () => {
    const email = newEmail();
    await post('/auth/signup', { name: 'X', email, password: PASSWORD, marketingOptIn: false });
    const code = await otpOf(email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await post('/auth/signup/verify', { email, code: wrong })).body.error.code).toBe('OTP_INVALID');
    const locked = await post('/auth/signup/verify', { email, code });
    expect(locked.body.error).toMatchObject({ code: 'OTP_INVALID', message: expect.stringContaining('Too many attempts') });

    const e2 = newEmail();
    await post('/auth/signup', { name: 'Y', email: e2, password: PASSWORD, marketingOptIn: false });
    await prisma.$executeRaw`UPDATE otp_codes SET expires_at = now() - interval '1 second' WHERE target = ${e2}`;
    expect((await post('/auth/signup/verify', { email: e2, code: await otpOf(e2) })).body.error.code).toBe('OTP_EXPIRED');
    expect((await post('/auth/signup/verify', { email: newEmail(), code: '123456' })).body.error.code).toBe('OTP_INVALID');
  });

  it('a code is single-use', async () => {
    const email = newEmail();
    await post('/auth/signup', { name: 'Z', email, password: PASSWORD, marketingOptIn: false });
    const code = await otpOf(email);
    expect((await post('/auth/signup/verify', { email, code })).status).toBe(200);
    expect((await post('/auth/signup/verify', { email, code })).body.error.code).toBe('OTP_INVALID');
  });

  it('verification links guest orders with the same email (any case) and nothing else', async () => {
    const email = newEmail();
    const cat = await catalog(prisma, [[{ price: 1000, onHand: 10 }]]);
    const mine = await tx(prisma, (t) => makeOrder(t, { lines: [{ variantId: cat.products[0]!.variantIds[0]!, qty: 1 }], reserve: false }));
    const other = await tx(prisma, (t) => makeOrder(t, { lines: [{ variantId: cat.products[0]!.variantIds[0]!, qty: 1 }], reserve: false }));
    await prisma.$executeRaw`UPDATE orders SET contact_email = ${email.toUpperCase()} WHERE id = ${mine.orderId}`;
    const a = await account(email);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: mine.orderId } })).userId).toBe(a.userId);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: other.orderId } })).userId).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'orders.link_verified_email', entityId: String(a.userId) } })).toBe(1);
  });

  it.each([
    ['missing password', { name: 'A', email: 'a@x.in', marketingOptIn: false }],
    ['short password', { name: 'A', email: 'a@x.in', password: 'short', marketingOptIn: false }],
    ['invalid email', { name: 'A', email: 'nope', password: PASSWORD, marketingOptIn: false }],
    ['unknown field', { name: 'A', email: 'a@x.in', password: PASSWORD, marketingOptIn: false, role: 'SUPER_ADMIN' }],
    ['bad phone', { name: 'A', email: 'a@x.in', password: PASSWORD, marketingOptIn: false, phone: '12' }],
    ['empty name', { name: ' ', email: 'a@x.in', password: PASSWORD, marketingOptIn: false }],
  ])('rejects %s with 400', async (_d, body) => {
    expect((await post('/auth/signup', body)).body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ── login ───────────────────────────────────────────────────────────────────
describe('login with password', () => {
  it('right password → tokens; wrong password and unknown email → identical 401', async () => {
    const a = await account();
    const ok = await post('/auth/login', { email: a.email.toUpperCase(), password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(refreshCookie(ok)).toBeTruthy();
    const wrong = await post('/auth/login', { email: a.email, password: 'wrong-password' });
    const unknown = await post('/auth/login', { email: newEmail(), password: 'wrong-password' });
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('pending accounts: NOT_VERIFIED only with the right password', async () => {
    const email = newEmail();
    await post('/auth/signup', { name: 'P', email, password: PASSWORD, marketingOptIn: false });
    expect((await post('/auth/login', { email, password: PASSWORD })).body.error.code).toBe('NOT_VERIFIED');
    expect((await post('/auth/login', { email, password: 'wrong-password' })).body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('5 failures lock the account for 15 minutes (423, even with the right password); expiry unlocks and resets', async () => {
    const a = await account();
    for (let i = 0; i < 4; i++) expect((await post('/auth/login', { email: a.email, password: 'bad-password' })).status).toBe(401);
    const fifth = await post('/auth/login', { email: a.email, password: 'bad-password' });
    expect(fifth.status).toBe(423);
    expect(fifth.body.error).toMatchObject({ code: 'ACCOUNT_LOCKED', details: { retryAfterSeconds: expect.any(Number) } });
    expect(fifth.body.error.details.retryAfterSeconds).toBeGreaterThan(890);
    expect((await post('/auth/login', { email: a.email, password: PASSWORD })).status).toBe(423);
    await prisma.$executeRaw`UPDATE users SET locked_until = now() - interval '1 second' WHERE id = ${a.userId}`;
    expect((await post('/auth/login', { email: a.email, password: PASSWORD })).status).toBe(200);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: a.userId } })).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
  });

  it('a successful login resets the failure counter', async () => {
    const a = await account();
    for (let i = 0; i < 3; i++) await post('/auth/login', { email: a.email, password: 'bad-password' });
    await post('/auth/login', { email: a.email, password: PASSWORD });
    for (let i = 0; i < 4; i++) expect((await post('/auth/login', { email: a.email, password: 'bad-password' })).status).toBe(401);
  });
});

describe('guest orders join the account at login (architecture.md §5.6)', () => {
  const guestOrder = async (email: string) => {
    const cat = await catalog(prisma, [[{ price: 1000, onHand: 10 }]]);
    const o = await tx(prisma, (t) => makeOrder(t, { lines: [{ variantId: cat.products[0]!.variantIds[0]!, qty: 1 }], reserve: false }));
    await prisma.$executeRaw`UPDATE orders SET contact_email = ${email} WHERE id = ${o.orderId}`;
    return o.orderId;
  };

  it('a verified customer who checked out as a guest sees the order after a password login', async () => {
    const a = await account();
    const orderId = await guestOrder(a.email.toUpperCase());
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).userId).toBeNull();
    expect((await post('/auth/login', { email: a.email, password: PASSWORD })).status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).userId).toBe(a.userId);
  });

  it('… and after an email-code login', async () => {
    const a = await account();
    const orderId = await guestOrder(a.email);
    await post('/auth/otp/request', { email: a.email, purpose: 'LOGIN' });
    expect((await post('/auth/otp/verify', { email: a.email, purpose: 'LOGIN', code: await otpOf(a.email) })).status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).userId).toBe(a.userId);
  });

  it('a failed login links nothing; orders already owned by someone else are never moved', async () => {
    const a = await account();
    const other = await account();
    const orderId = await guestOrder(a.email);
    const owned = await guestOrder(a.email);
    await prisma.order.update({ where: { id: owned }, data: { userId: other.userId } });
    await post('/auth/login', { email: a.email, password: 'wrong-password' });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).userId).toBeNull();
    await post('/auth/login', { email: a.email, password: PASSWORD });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).userId).toBe(a.userId);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: owned } })).userId).toBe(other.userId);
  });
});

describe('login with email OTP', () => {
  it('always answers {sent:true}; only active accounts get a code; the code logs in once', async () => {
    const a = await account();
    const unknown = newEmail();
    expect((await post('/auth/otp/request', { email: unknown, purpose: 'LOGIN' })).body).toEqual({ sent: true, resendAfter: 30 });
    expect(await lastMail(unknown)).toBeNull();
    expect((await post('/auth/otp/request', { email: a.email, purpose: 'LOGIN' })).body).toEqual({ sent: true, resendAfter: 30 });
    const code = String((await lastMail(a.email, 'otp'))!.data.code);
    expect((await lastMail(a.email, 'otp'))!.data.purpose).toBe('LOGIN');
    const ok = await post('/auth/otp/verify', { email: a.email, purpose: 'LOGIN', code });
    expect(ok.status).toBe(200);
    expect(ok.body.user.id).toBe(a.userId);
    expect((await post('/auth/otp/verify', { email: a.email, purpose: 'LOGIN', code })).body.error.code).toBe('OTP_INVALID');
  });

  it('cooldown and hourly cap per email are silent', async () => {
    const a = await account();
    await post('/auth/otp/request', { email: a.email, purpose: 'LOGIN' });
    await post('/auth/otp/request', { email: a.email, purpose: 'LOGIN' });                 // inside 30 s
    expect(await prisma.otpCode.count({ where: { target: a.email, purpose: 'LOGIN' } })).toBe(1);
    await prisma.$executeRaw`UPDATE otp_codes SET created_at = now() - interval '31 seconds' WHERE target = ${a.email}`;
    for (let i = 0; i < 6; i++) {
      await post('/auth/otp/request', { email: a.email, purpose: 'LOGIN' });
      await prisma.$executeRaw`UPDATE otp_codes SET created_at = created_at - interval '31 seconds' WHERE target = ${a.email}`;
    }
    expect(await prisma.otpCode.count({ where: { target: a.email, purpose: 'LOGIN' } })).toBe(5);       // 5 per hour
  });

  it('a blocked account gets no code and cannot use an earlier one', async () => {
    const a = await account();
    await post('/auth/otp/request', { email: a.email, purpose: 'LOGIN' });
    const code = await otpOf(a.email);
    await service.revokeAll(a.userId, 'BLOCKED', true);
    expect((await post('/auth/otp/verify', { email: a.email, purpose: 'LOGIN', code })).body.error.code).toBe('OTP_INVALID');
  });

  it('rejects other purposes and malformed codes', async () => {
    expect((await post('/auth/otp/request', { email: 'a@x.in', purpose: 'SIGNUP_VERIFY' })).status).toBe(400);
    expect((await post('/auth/otp/verify', { email: 'a@x.in', purpose: 'LOGIN', code: '12ab56' })).status).toBe(400);
  });
});

// ── refresh rotation (architecture.md §5.2, AT-11) ─────────────────────────
describe('refresh rotation, grace window and reuse detection', () => {
  it('rotates: new cookie, old token ROTATED, new access token works', async () => {
    const a = await account();
    const r = await post('/auth/refresh', {}, { cookie: a.refresh });
    expect(r.status).toBe(200);
    const next = refreshCookie(r)!;
    expect(next).toBeTruthy();
    expect(next).not.toBe(a.refresh);
    expect((await prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: sha256(a.refresh) } })).status).toBe('ROTATED');
    expect((await me(r.body.accessToken)).status).toBe(200);
    expect((await post('/auth/refresh', {}, { cookie: next })).status).toBe(200);
  });

  it('three tabs refreshing the same token at once: all succeed, exactly one new cookie, session stays alive', async () => {
    const a = await account();
    const rs = await Promise.all([1, 2, 3].map(() => post('/auth/refresh', {}, { cookie: a.refresh })));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    const minted = rs.map(refreshCookie).filter(Boolean);
    expect(minted).toHaveLength(1);
    expect((await prisma.session.findFirstOrThrow({ where: { userId: a.userId } })).revokedAt).toBeNull();
    for (const r of rs) expect((await me(r.body.accessToken)).status).toBe(200);
    expect((await post('/auth/refresh', {}, { cookie: minted[0]! })).status).toBe(200);
  });

  it('a late tab inside the 30 s grace window gets an access token but no cookie', async () => {
    const a = await account();
    await post('/auth/refresh', {}, { cookie: a.refresh });
    const late = await post('/auth/refresh', {}, { cookie: a.refresh });
    expect(late.status).toBe(200);
    expect(refreshCookie(late)).toBeNull();
    expect(setCookies(late)).toEqual([]);
  });

  it('replay of a rotated token after the grace window revokes the whole session (stolen token)', async () => {
    const a = await account();
    const first = await post('/auth/refresh', {}, { cookie: a.refresh });
    const successor = refreshCookie(first)!;
    expect((await me(first.body.accessToken)).status).toBe(200);                     // cache now holds "valid"
    await prisma.$executeRaw`UPDATE refresh_tokens SET rotated_at = now() - interval '31 seconds' WHERE token_hash = ${sha256(a.refresh)}`;
    const replay = await post('/auth/refresh', {}, { cookie: a.refresh });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('SESSION_INVALID');
    expect(setCookies(replay)).toEqual([expect.stringMatching(new RegExp(`^${COOKIE}=; Path=/v1/auth; Max-Age=0; HttpOnly; Secure; SameSite=Strict$`))]);
    const s = await prisma.session.findFirstOrThrow({ where: { userId: a.userId } });
    expect(s).toMatchObject({ revokeReason: 'REUSE_DETECTED' });
    expect(s.revokedAt).not.toBeNull();
    expect((await post('/auth/refresh', {}, { cookie: successor })).status).toBe(401);  // the thief's successor is dead too
    expect((await me(first.body.accessToken)).status).toBe(401);                      // next request, despite the warm cache
    expect(await prisma.auditLog.count({ where: { action: 'security.refresh_reuse', actorId: a.userId } })).toBe(1);
    expect(await mailCount(a.email, 'new_signin_activity')).toBe(1);
  });

  it('a rotated token whose successor was already rotated is reuse even inside the grace window', async () => {
    const a = await account();
    const second = refreshCookie(await post('/auth/refresh', {}, { cookie: a.refresh }))!;
    await post('/auth/refresh', {}, { cookie: second });                                // successor rotated
    expect((await post('/auth/refresh', {}, { cookie: a.refresh })).status).toBe(401);
    expect((await prisma.session.findFirstOrThrow({ where: { userId: a.userId } })).revokeReason).toBe('REUSE_DETECTED');
  });

  it('no cookie, unknown token, expired token, revoked session → 401 with the cookie cleared', async () => {
    const a = await account();
    for (const r of [await post('/auth/refresh', {}), await post('/auth/refresh', {}, { cookie: randomToken() })]) {
      expect(r.status).toBe(401);
      expect(setCookies(r)[0]).toContain('Max-Age=0');
    }
    await prisma.$executeRaw`UPDATE refresh_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = ${sha256(a.refresh)}`;
    expect((await post('/auth/refresh', {}, { cookie: a.refresh })).status).toBe(401);
    const b = await account();
    await prisma.$executeRaw`UPDATE sessions SET revoked_at = now() WHERE user_id = ${b.userId}`;
    expect((await post('/auth/refresh', {}, { cookie: b.refresh })).status).toBe(401);
  });

  it('an admin-audience refresh token is refused on the storefront endpoint', async () => {
    const a = await account();
    await fn.changeRole(prisma, a.userId, 'STAFF');
    const tok = randomToken();
    await prisma.$executeRaw`
      WITH s AS (INSERT INTO sessions (user_id, audience, auth_version, idle_expires_at, absolute_expires_at)
                 SELECT id, 'ADMIN', admin_auth_version, now() + interval '1 hour', now() + interval '1 day' FROM users WHERE id = ${a.userId} RETURNING id)
      INSERT INTO refresh_tokens (session_id, token_hash, expires_at) SELECT id, ${sha256(tok)}, now() + interval '1 hour' FROM s`;
    expect((await post('/auth/refresh', {}, { cookie: tok })).status).toBe(401);
  });

  it('refresh rejects a body and a missing Origin', async () => {
    const a = await account();
    expect((await post('/auth/refresh', { x: 1 }, { cookie: a.refresh })).status).toBe(400);
    expect((await post('/auth/refresh', {}, { cookie: a.refresh, origin: null })).body.error.code).toBe('ORIGIN_REJECTED');
    expect((await post('/auth/refresh', {}, { cookie: a.refresh, origin: 'https://evil.example' })).body.error.code).toBe('ORIGIN_REJECTED');
  });
});

// ── logout ──────────────────────────────────────────────────────────────────
describe('logout and logout everywhere', () => {
  it('logout revokes the session at once (warm cache too) and clears the cookie with identical attributes', async () => {
    const a = await account();
    expect((await me(a.access)).status).toBe(200);
    const set = setCookies(a.res).find((x) => x.startsWith(`${COOKIE}=`))!;
    const out = await post('/auth/logout', {}, { cookie: a.refresh });
    expect(out.status).toBe(200);
    const clear = setCookies(out)[0]!;
    const attrs = (c: string) => c.split('; ').slice(1).filter((x) => !x.startsWith('Max-Age'));
    expect(attrs(clear)).toEqual(attrs(set));
    expect(clear).toContain('Max-Age=0');
    expect((await me(a.access)).body.error.code).toBe('SESSION_INVALID');
    expect((await post('/auth/refresh', {}, { cookie: a.refresh })).status).toBe(401);
  });

  it('logout without a cookie still clears and succeeds (idempotent)', async () => {
    const r = await post('/auth/logout', {});
    expect(r.status).toBe(200);
    expect(setCookies(r)[0]).toContain('Max-Age=0');
  });

  it('logout-all needs a Bearer token and ends every session of the user only', async () => {
    const a = await account();
    const second = await post('/auth/login', { email: a.email, password: PASSWORD });
    const other = await account();
    expect((await post('/auth/logout-all', {})).body.error.code).toBe('UNAUTHENTICATED');
    expect((await post('/auth/logout-all', {}, { bearer: a.access })).status).toBe(200);
    expect((await me(a.access)).status).toBe(401);
    expect((await me(second.body.accessToken)).status).toBe(401);
    expect((await post('/auth/refresh', {}, { cookie: refreshCookie(second)! })).status).toBe(401);
    expect((await me(other.access)).status).toBe(200);
  });
});

// ── blocking, roles and the auth middleware ─────────────────────────────────
describe('session checks on every request', () => {
  it("a blocked user's next request → 401; refresh and login are refused", async () => {
    const a = await account();
    expect((await me(a.access)).status).toBe(200);
    await service.revokeAll(a.userId, 'BLOCKED', true);
    expect((await me(a.access)).body.error.code).toBe('SESSION_INVALID');
    expect((await post('/auth/refresh', {}, { cookie: a.refresh })).status).toBe(401);
    expect((await post('/auth/login', { email: a.email, password: PASSWORD })).body.error.code).toBe('ACCOUNT_BLOCKED');
  });

  it('blocking directly in the database is enforced within the cache TTL, and immediately on a cold cache', async () => {
    const a = await account();
    await fn.revokeAllSessions(prisma, a.userId, 'BLOCKED', true);               // no cache tombstone written
    await redis.del(`session:${(await prisma.session.findFirstOrThrow({ where: { userId: a.userId } })).id}`);
    expect((await me(a.access)).status).toBe(401);
  });

  it('with Redis down the middleware falls back to PostgreSQL', async () => {
    const dead = new Redis('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null, enableOfflineQueue: false });
    dead.on('error', () => {});
    const { app: offline } = build(new RedisSessionCache(dead));
    const a = await account();
    expect((await me(a.access, offline)).status).toBe(200);
    await service.revokeAll(a.userId, 'BLOCKED', true);
    expect((await me(a.access, offline)).status).toBe(401);
    dead.disconnect();
  });

  it('a role change keeps storefront sessions valid (admin_auth_version only)', async () => {
    const a = await account();
    await fn.changeRole(prisma, a.userId, 'STAFF');
    expect((await me(a.access)).status).toBe(200);
  });

  it.each([
    ['no header', async () => request(app).get('/v1/me'), 'UNAUTHENTICATED'],
    ['malformed header', async () => request(app).get('/v1/me').set('Authorization', 'Basic abc'), 'UNAUTHENTICATED'],
    ['expired token', async (a: { userId: number; sid: string }) => me(await signAccessToken(JWT, { sub: String(a.userId), sid: a.sid, aud: 'storefront', ver: 1 }, 600, new Date(Date.now() - 3_600_000))), 'UNAUTHENTICATED'],
    ['admin audience', async (a: { userId: number; sid: string }) => me(await signAccessToken(JWT, { sub: String(a.userId), sid: a.sid, aud: 'admin', ver: 1 }, 600)), 'UNAUTHENTICATED'],
    ['version mismatch', async (a: { userId: number; sid: string }) => me(await signAccessToken(JWT, { sub: String(a.userId), sid: a.sid, aud: 'storefront', ver: 99 }, 600)), 'SESSION_INVALID'],
    ['someone else’s session id', async (a: { userId: number; sid: string }) => me(await signAccessToken(JWT, { sub: String(a.userId + 1000), sid: a.sid, aud: 'storefront', ver: 1 }, 600)), 'SESSION_INVALID'],
    ['unknown session id', async (a: { userId: number }) => me(await signAccessToken(JWT, { sub: String(a.userId), sid: '00000000-0000-0000-0000-000000000000', aud: 'storefront', ver: 1 }, 600)), 'SESSION_INVALID'],
  ] as const)('rejects %s', async (_d, f, codeName) => {
    const a = await account();
    const sid = (await prisma.session.findFirstOrThrow({ where: { userId: a.userId } })).id;
    const r = await (f as (x: { userId: number; sid: string }) => Promise<request.Response>)({ userId: a.userId, sid });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe(codeName);
  });
});

// ── passwords ───────────────────────────────────────────────────────────────
describe('forgot / reset password', () => {
  const tokenFrom = async (email: string) => new URL(String((await lastMail(email, 'password_reset'))!.data.link)).searchParams.get('token')!;

  it('always {ok:true}; only an active account gets a link', async () => {
    const unknown = newEmail();
    expect((await post('/auth/password/forgot', { email: unknown })).body).toEqual({ ok: true });
    expect(await lastMail(unknown)).toBeNull();
  });

  it('reset changes the password, ends every session, unlocks the account and invalidates other links', async () => {
    const a = await account();
    await post('/auth/password/forgot', { email: a.email });
    const older = await tokenFrom(a.email);
    await post('/auth/password/forgot', { email: a.email });
    const token = await tokenFrom(a.email);
    expect(token).not.toBe(older);
    await prisma.$executeRaw`UPDATE users SET locked_until = now() + interval '10 minutes' WHERE id = ${a.userId}`;
    const r = await post('/auth/password/reset', { token, password: 'brand-new-pass-1' });
    expect(r.status).toBe(200);
    expect(setCookies(r)[0]).toContain('Max-Age=0');
    expect((await me(a.access)).status).toBe(401);
    expect((await post('/auth/refresh', {}, { cookie: a.refresh })).status).toBe(401);
    expect((await post('/auth/login', { email: a.email, password: PASSWORD })).status).toBe(401);
    expect((await post('/auth/login', { email: a.email, password: 'brand-new-pass-1' })).status).toBe(200);
    expect((await post('/auth/password/reset', { token, password: 'another-pass-12' })).body.error.code).toBe('TOKEN_INVALID');
    expect((await post('/auth/password/reset', { token: older, password: 'another-pass-12' })).body.error.code).toBe('TOKEN_INVALID');
    expect(await mailCount(a.email, 'password_changed')).toBe(1);
  });

  it('expired or unknown tokens and weak passwords are rejected', async () => {
    const a = await account();
    await post('/auth/password/forgot', { email: a.email });
    const token = await tokenFrom(a.email);
    expect((await post('/auth/password/reset', { token, password: 'short' })).status).toBe(400);
    await prisma.$executeRaw`UPDATE password_reset_tokens SET expires_at = now() - interval '1 second' WHERE user_id = ${a.userId}`;
    expect((await post('/auth/password/reset', { token, password: 'long-enough-1' })).body.error.code).toBe('TOKEN_INVALID');
    expect((await post('/auth/password/reset', { token: randomToken(), password: 'long-enough-1' })).body.error.code).toBe('TOKEN_INVALID');
  });
});

describe('set-password link (guest checkout → account)', () => {
  const tokenOf = (link: string) => new URL(link).searchParams.get('token')!;

  it('creates a verified account, links guest orders and logs in; the link then cannot be reused', async () => {
    const email = newEmail();
    const cat = await catalog(prisma, [[{ price: 1000, onHand: 10 }]]);
    const o = await tx(prisma, (t) => makeOrder(t, { lines: [{ variantId: cat.products[0]!.variantIds[0]!, qty: 1 }], reserve: false }));
    await prisma.$executeRaw`UPDATE orders SET contact_email = ${email} WHERE id = ${o.orderId}`;
    const token = tokenOf(service.setPasswordLink(email));
    const r = await post('/auth/set-password', { token, password: 'guest-pass-123' });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ email, emailVerified: true });
    expect(refreshCookie(r)).toBeTruthy();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).userId).toBe(r.body.user.id);
    expect((await post('/auth/set-password', { token, password: 'guest-pass-456' })).body.error.code).toBe('ACCOUNT_EXISTS');
    expect((await post('/auth/login', { email, password: 'guest-pass-123' })).status).toBe(200);
  });

  it('activates a pending signup with the same email', async () => {
    const email = newEmail();
    await post('/auth/signup', { name: 'P', email, password: PASSWORD, marketingOptIn: false });
    const r = await post('/auth/set-password', { token: tokenOf(service.setPasswordLink(email)), password: 'guest-pass-123' });
    expect(r.status).toBe(200);
    expect(await prisma.user.findFirstOrThrow({ where: { email } })).toMatchObject({ status: 'ACTIVE' });
  });

  it('rejects tampered, expired and wrong-purpose links, and blocked accounts', async () => {
    const email = newEmail();
    const token = tokenOf(service.setPasswordLink(email));
    expect((await post('/auth/set-password', { token: token.slice(0, -2) + 'xx', password: 'guest-pass-123' })).body.error.code).toBe('TOKEN_INVALID');
    expect((await post('/auth/set-password', { token: signLink(LINK_SECRET, 'set_password', { e: email }, 60, new Date(Date.now() - 3_600_000)), password: 'guest-pass-123' })).body.error.code).toBe('TOKEN_INVALID');
    expect((await post('/auth/set-password', { token: signLink(LINK_SECRET, 'other', { e: email }, 600), password: 'guest-pass-123' })).body.error.code).toBe('TOKEN_INVALID');
    const b = await account();
    await service.revokeAll(b.userId, 'BLOCKED', true);
    await prisma.$executeRaw`UPDATE users SET password_hash = NULL WHERE id = ${b.userId}`;
    expect((await post('/auth/set-password', { token: tokenOf(service.setPasswordLink(b.email)), password: 'guest-pass-123' })).body.error.code).toBe('ACCOUNT_BLOCKED');
  });
});

describe('CSRF layers on cookie routes', () => {
  it.each(['/auth/login', '/auth/signup', '/auth/logout', '/auth/password/forgot'])('%s: missing or foreign Origin → 403, form posts → 415', async (path) => {
    expect((await post(path, {}, { origin: null })).body.error.code).toBe('ORIGIN_REJECTED');
    expect((await post(path, {}, { origin: 'https://evil.example' })).status).toBe(403);
    const form = await request(app).post(`/v1${path}`).set('Origin', ORIGIN).set('Content-Type', 'application/x-www-form-urlencoded').send('email=a@x.in');
    expect(form.status).toBe(415);
  });
  it('cross-site Sec-Fetch-Site is rejected even with an allowed Origin', async () => {
    expect((await post('/auth/login', { email: 'a@x.in', password: 'x' }).set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
  });
});

describe('in-memory cache variant', () => {
  it('behaves the same for revocation', async () => {
    const { app: memApp, service: memService } = build(new MemorySessionCache());
    const email = newEmail();
    await post('/auth/signup', { name: 'M', email, password: PASSWORD, marketingOptIn: false }, { a: memApp });
    const v = await post('/auth/signup/verify', { email, code: await otpOf(email) }, { a: memApp });
    expect((await me(v.body.accessToken, memApp)).status).toBe(200);
    await memService.logoutAll(v.body.user.id);
    expect((await me(v.body.accessToken, memApp)).status).toBe(401);
  });
});
