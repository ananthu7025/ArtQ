// Task 1.6 (MFA deferred by the owner): admin login with email + password, separate audience/cookie, refresh, logout,
// role changes, blocking, password step-up for sensitive actions, per-admin rate limit. Real PostgreSQL + Redis.
import { createServer } from 'node:http';
import type { PrismaClient, UserRole } from '@prisma/client';
import { Router, type Express } from 'express';
import { decodeJwt } from 'jose';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { createApp } from '../../src/app.js';
import { adminAuthRouter } from '../../src/auth/admin-routes.js';
import { cookieSpec } from '../../src/auth/cookies.js';
import { requireAdmin, requireStepUp } from '../../src/auth/middleware.js';
import { authRouter } from '../../src/auth/routes.js';
import { AuthService, DEFAULT_AUTH_TIMINGS } from '../../src/auth/service.js';
import { RedisSessionCache, type SessionCache } from '../../src/auth/session-cache.js';
import { sha256 } from '../../src/auth/tokens.js';
import { hashPassword } from '../../src/lib/password.js';
import { MemoryRateLimiter, type RateLimiter } from '../../src/middleware/rateLimit.js';
import { seedAdmin } from '../../src/seed/steps.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { uniq } from '../helpers/fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const WEB = 'http://localhost:3000';
const ADMIN = 'http://localhost:5173';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const ADMIN_COOKIE = cookieSpec('adminRefresh', 'test').name;
const WEB_COOKIE = cookieSpec('refresh', 'test').name;
const PASSWORD = 'staff-password-123';
const NO_LIMIT: RateLimiter = { hit: async () => ({ count: 0, resetMs: 60_000 }) };

let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, cache: SessionCache, service: AuthService, app: Express;

function build(limiter: RateLimiter): Express {
  const deps = { prisma, cache, jwt: JWT };
  const sensitive = Router();
  sensitive.post('/admin/test/sensitive', requireAdmin(deps), requireStepUp((sid) => service.hasRecentStepUp(sid)), (_req, res) => { res.json({ ok: true }); });
  return createApp({
    version: 't', origins: { storefront: [WEB], admin: [ADMIN] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [
      authRouter({ ...deps, service, env: 'test', refreshMaxAgeS: DEFAULT_AUTH_TIMINGS.refreshIdleS, limiter: NO_LIMIT }),
      adminAuthRouter({ ...deps, service, env: 'test', limiter }),
      sensitive,
    ],
  });
}

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  cache = new RedisSessionCache(redis);
  service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: WEB });
  app = build(NO_LIMIT);
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });

const post = (path: string, body: object = {}, o: { origin?: string | null; cookie?: [string, string]; bearer?: string; a?: Express } = {}) => {
  let r = request(o.a ?? app).post(`/v1${path}`).set('Content-Type', 'application/json');
  if (o.origin !== null) r = r.set('Origin', o.origin ?? (path.startsWith('/admin') ? ADMIN : WEB));
  if (o.cookie) r = r.set('Cookie', `${o.cookie[0]}=${o.cookie[1]}`);
  if (o.bearer) r = r.set('Authorization', `Bearer ${o.bearer}`);
  return r.send(body);
};
const get = (path: string, bearer: string) => request(app).get(`/v1${path}`).set('Authorization', `Bearer ${bearer}`);
const cookieOf = (res: request.Response, name: string) => {
  const c = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((x) => x.startsWith(`${name}=`));
  return c ? c.slice(name.length + 1).split(';')[0]! : null;
};
const rawCookie = (res: request.Response, name: string) => ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((x) => x.startsWith(`${name}=`));

async function user(role: UserRole, status: 'ACTIVE' | 'BLOCKED' | 'PENDING_VERIFICATION' = 'ACTIVE') {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  const u = await prisma.user.create({ data: { email, role, status, passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: status === 'PENDING_VERIFICATION' ? null : new Date() } });
  return { id: u.id, email };
}
async function adminSession(role: UserRole = 'ADMIN') {
  const u = await user(role);
  const res = await post('/admin/auth/login', { email: u.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { ...u, access: res.body.accessToken as string, refresh: cookieOf(res, ADMIN_COOKIE)!, res };
}

describe('admin login', () => {
  it.each(['STAFF', 'ADMIN', 'SUPER_ADMIN'] as const)('%s logs in: 5-minute access token, admin cookie on /v1/admin/auth, audited', async (role) => {
    const s = await adminSession(role);
    expect(s.res.body.user).toMatchObject({ email: s.email, role });
    const c = rawCookie(s.res, ADMIN_COOKIE)!;
    expect(c).toMatch(/; Path=\/v1\/admin\/auth; Max-Age=43200; HttpOnly; Secure; SameSite=Strict$/);
    expect(rawCookie(s.res, WEB_COOKIE)).toBeUndefined();
    const jwt = decodeJwt(s.access);
    expect(jwt).toMatchObject({ aud: 'admin', iss: 'artq-test', sub: String(s.id) });
    expect(jwt.exp! - jwt.iat!).toBe(300);
    expect((await get('/admin/me', s.access)).body.user).toMatchObject({ id: s.id, role });
    expect(await prisma.auditLog.count({ where: { action: 'admin.login', actorId: s.id } })).toBe(1);
    const session = await prisma.session.findFirstOrThrow({ where: { userId: s.id } });
    expect(session.audience).toBe('ADMIN');
    expect(session.absoluteExpiresAt.getTime() - session.createdAt.getTime()).toBeGreaterThan(7 * 86_400_000 - 60_000);
  });

  it('a customer with the right password, a wrong password and an unknown email all get the same 401', async () => {
    const c = await user('CUSTOMER');
    const s = await user('STAFF');
    const customer = await post('/admin/auth/login', { email: c.email, password: PASSWORD });
    const wrong = await post('/admin/auth/login', { email: s.email, password: 'not-the-password' });
    const unknown = await post('/admin/auth/login', { email: `nobody${uniq()}@artq.in`, password: PASSWORD });
    expect([customer.status, wrong.status, unknown.status]).toEqual([401, 401, 401]);
    expect(customer.body).toEqual(wrong.body);
    expect(unknown.body).toEqual(wrong.body);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: c.id } })).failedLoginCount).toBe(0);   // right password is not a failure
  });

  it('pending accounts are refused; blocked staff get ACCOUNT_BLOCKED (only with the right password)', async () => {
    const p = await user('STAFF', 'PENDING_VERIFICATION');
    expect((await post('/admin/auth/login', { email: p.email, password: PASSWORD })).body.error.code).toBe('INVALID_CREDENTIALS');
    const b = await user('ADMIN', 'BLOCKED');
    expect((await post('/admin/auth/login', { email: b.email, password: PASSWORD })).body.error.code).toBe('ACCOUNT_BLOCKED');
    expect((await post('/admin/auth/login', { email: b.email, password: 'nope-nope-1' })).body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('the lockout is shared with the storefront: 5 admin failures lock both logins', async () => {
    const s = await user('STAFF');
    for (let i = 0; i < 4; i++) expect((await post('/admin/auth/login', { email: s.email, password: 'bad-password' })).status).toBe(401);
    expect((await post('/admin/auth/login', { email: s.email, password: 'bad-password' })).status).toBe(423);
    expect((await post('/admin/auth/login', { email: s.email, password: PASSWORD })).status).toBe(423);
    expect((await post('/auth/login', { email: s.email, password: PASSWORD })).status).toBe(423);
  });

  it('the seeded super admin can log in with the seeded password', async () => {
    const email = `owner${uniq()}@artq.in`;
    await prisma.$executeRaw`UPDATE users SET role = 'ADMIN' WHERE role = 'SUPER_ADMIN'`;   // seedAdmin creates only the first one
    await seedAdmin(prisma, { email, password: 'owner-passphrase-1' });
    const r = await post('/admin/auth/login', { email, password: 'owner-passphrase-1' });
    expect(r.status).toBe(200);
    expect(r.body.user.role).toBe('SUPER_ADMIN');
  });

  it('origin: only the admin origin may call /v1/admin/auth/*', async () => {
    const s = await user('STAFF');
    expect((await post('/admin/auth/login', { email: s.email, password: PASSWORD }, { origin: WEB })).body.error.code).toBe('ORIGIN_REJECTED');
    expect((await post('/admin/auth/login', { email: s.email, password: PASSWORD }, { origin: null })).status).toBe(403);
    expect((await post('/auth/login', { email: s.email, password: PASSWORD }, { origin: ADMIN })).status).toBe(403);
  });

  it.each([
    ['missing password', { email: 'a@artq.in' }],
    ['unknown field', { email: 'a@artq.in', password: 'x', mfa: '123456' }],
    ['bad email', { email: 'nope', password: 'x' }],
  ])('rejects %s with 400', async (_d, body) => {
    expect((await post('/admin/auth/login', body)).body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('storefront and admin are separate', () => {
  it('tokens and cookies only work for their own audience', async () => {
    const s = await adminSession('STAFF');
    const web = await post('/auth/login', { email: s.email, password: PASSWORD });       // staff may also shop
    expect(web.status).toBe(200);
    const webAccess = web.body.accessToken as string;
    const webRefresh = cookieOf(web, WEB_COOKIE)!;
    expect((await get('/admin/me', webAccess)).body.error.code).toBe('UNAUTHENTICATED');
    expect((await get('/me', s.access)).body.error.code).toBe('UNAUTHENTICATED');
    expect((await post('/admin/auth/refresh', {}, { cookie: [ADMIN_COOKIE, webRefresh] })).status).toBe(401);
    expect((await post('/auth/refresh', {}, { cookie: [WEB_COOKIE, s.refresh] })).status).toBe(401);
    expect((await post('/admin/auth/logout', {}, { cookie: [ADMIN_COOKIE, webRefresh] })).status).toBe(200);
    expect((await get('/me', webAccess)).status).toBe(200);                               // storefront session untouched
    expect((await get('/admin/me', s.access)).status).toBe(200);
  });
});

describe('admin refresh and logout', () => {
  it('refresh rotates with the 12-hour cookie; replay after the grace window revokes the session', async () => {
    const s = await adminSession();
    const r = await post('/admin/auth/refresh', {}, { cookie: [ADMIN_COOKIE, s.refresh] });
    expect(r.status).toBe(200);
    expect(decodeJwt(r.body.accessToken).aud).toBe('admin');
    expect(rawCookie(r, ADMIN_COOKIE)).toContain('Max-Age=43200');
    await prisma.$executeRaw`UPDATE refresh_tokens SET rotated_at = now() - interval '31 seconds' WHERE token_hash = ${sha256(s.refresh)}`;
    expect((await post('/admin/auth/refresh', {}, { cookie: [ADMIN_COOKIE, s.refresh] })).status).toBe(401);
    expect((await prisma.session.findFirstOrThrow({ where: { userId: s.id, audience: 'ADMIN' } })).revokeReason).toBe('REUSE_DETECTED');
    expect((await get('/admin/me', r.body.accessToken)).status).toBe(401);
  });

  it('logout ends the session immediately and clears the admin cookie with identical attributes', async () => {
    const s = await adminSession();
    expect((await get('/admin/me', s.access)).status).toBe(200);
    const out = await post('/admin/auth/logout', {}, { cookie: [ADMIN_COOKIE, s.refresh] });
    expect(out.status).toBe(200);
    const attrs = (c: string) => c.split('; ').slice(1).filter((x) => !x.startsWith('Max-Age'));
    expect(attrs(rawCookie(out, ADMIN_COOKIE)!)).toEqual(attrs(rawCookie(s.res, ADMIN_COOKIE)!));
    expect(rawCookie(out, ADMIN_COOKIE)).toContain('Max-Age=0');
    expect((await get('/admin/me', s.access)).body.error.code).toBe('SESSION_INVALID');
    expect((await post('/admin/auth/refresh', {}, { cookie: [ADMIN_COOKIE, s.refresh] })).status).toBe(401);
  });

  it('logout-all needs an admin token and ends every session', async () => {
    const s = await adminSession();
    const second = await post('/admin/auth/login', { email: s.email, password: PASSWORD });
    expect((await post('/admin/auth/logout-all', {})).body.error.code).toBe('UNAUTHENTICATED');
    expect((await post('/admin/auth/logout-all', {}, { bearer: s.access })).status).toBe(200);
    expect((await get('/admin/me', second.body.accessToken)).status).toBe(401);
  });
});

describe('role changes and blocking', () => {
  it('demotion ends admin sessions at once (warm cache) but keeps the storefront session; the new role applies at next login', async () => {
    const s = await adminSession('ADMIN');
    const web = await post('/auth/login', { email: s.email, password: PASSWORD });
    expect((await get('/admin/me', s.access)).status).toBe(200);
    await service.changeRole(s.id, 'STAFF');
    expect((await get('/admin/me', s.access)).body.error.code).toBe('SESSION_INVALID');
    expect((await post('/admin/auth/refresh', {}, { cookie: [ADMIN_COOKIE, s.refresh] })).status).toBe(401);
    expect((await get('/me', web.body.accessToken)).status).toBe(200);
    const again = await post('/admin/auth/login', { email: s.email, password: PASSWORD });
    expect((await get('/admin/me', again.body.accessToken)).body.user.role).toBe('STAFF');
  });

  it('a user demoted to CUSTOMER can no longer use the admin panel', async () => {
    const s = await adminSession('STAFF');
    await service.changeRole(s.id, 'CUSTOMER');
    expect((await get('/admin/me', s.access)).status).toBe(401);
    expect((await post('/admin/auth/login', { email: s.email, password: PASSWORD })).body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it("blocking ends the admin session on the next request", async () => {
    const s = await adminSession();
    expect((await get('/admin/me', s.access)).status).toBe(200);
    await service.revokeAll(s.id, 'BLOCKED', true);
    expect((await get('/admin/me', s.access)).status).toBe(401);
    expect((await post('/admin/auth/login', { email: s.email, password: PASSWORD })).body.error.code).toBe('ACCOUNT_BLOCKED');
  });

  it('the cached role is refreshed after a role change (role is taken from the session lookup)', async () => {
    const s = await adminSession('SUPER_ADMIN');
    await get('/admin/me', s.access);
    await service.changeRole(s.id, 'ADMIN');
    const again = await post('/admin/auth/login', { email: s.email, password: PASSWORD });
    expect((await get('/admin/me', again.body.accessToken)).body.user.role).toBe('ADMIN');
  });
});

describe('step-up (password re-check for sensitive actions)', () => {
  it('sensitive routes need a password re-check within 10 minutes', async () => {
    const s = await adminSession();
    expect((await post('/admin/test/sensitive', {}, { bearer: s.access })).body.error.code).toBe('STEP_UP_REQUIRED');
    const up = await post('/admin/auth/step-up', { password: PASSWORD }, { bearer: s.access });
    expect(up.status).toBe(200);
    const until = new Date(up.body.stepUpUntil).getTime();
    expect(until - Date.now()).toBeGreaterThan(590_000);
    expect(until - Date.now()).toBeLessThanOrEqual(600_000);
    expect((await post('/admin/test/sensitive', {}, { bearer: s.access })).status).toBe(200);
    await prisma.$executeRaw`UPDATE sessions SET mfa_verified_at = now() - interval '601 seconds' WHERE user_id = ${s.id}`;
    expect((await post('/admin/test/sensitive', {}, { bearer: s.access })).body.error.code).toBe('STEP_UP_REQUIRED');
    expect(await prisma.auditLog.count({ where: { action: 'admin.step_up', actorId: s.id } })).toBe(1);
  });

  it('a step-up on one session does not cover another session', async () => {
    const s = await adminSession();
    const other = await post('/admin/auth/login', { email: s.email, password: PASSWORD });
    await post('/admin/auth/step-up', { password: PASSWORD }, { bearer: s.access });
    expect((await post('/admin/test/sensitive', {}, { bearer: other.body.accessToken })).body.error.code).toBe('STEP_UP_REQUIRED');
  });

  it('wrong passwords fail and count toward the lockout; no token or a storefront token is refused', async () => {
    const s = await adminSession();
    expect((await post('/admin/auth/step-up', { password: 'wrong-password' }, { bearer: s.access })).body.error.code).toBe('INVALID_CREDENTIALS');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: s.id } })).failedLoginCount).toBe(1);
    expect((await post('/admin/test/sensitive', {}, { bearer: s.access })).body.error.code).toBe('STEP_UP_REQUIRED');
    expect((await post('/admin/auth/step-up', { password: PASSWORD })).body.error.code).toBe('UNAUTHENTICATED');
    const web = await post('/auth/login', { email: s.email, password: PASSWORD });
    expect((await post('/admin/auth/step-up', { password: PASSWORD }, { bearer: web.body.accessToken })).status).toBe(401);
    expect((await post('/admin/test/sensitive', {}, {})).body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('per-admin rate limit (api.md §6: 600/min/user)', () => {
  it('the 601st authenticated admin request in a minute → 429; another admin is unaffected', async () => {
    const limited = build(new MemoryRateLimiter());
    const srv = createServer(limited).listen(0);
    onTestFinished(() => { srv.close(); });
    const u = await user('STAFF');
    const login = await request(srv).post('/v1/admin/auth/login').set('Origin', ADMIN).set('Content-Type', 'application/json').send({ email: u.email, password: PASSWORD });
    const token = login.body.accessToken as string;
    for (let i = 0; i < 600; i++) {
      const r = await request(srv).get('/v1/admin/me').set('Authorization', `Bearer ${token}`);
      if (r.status !== 200) throw new Error(`request ${i + 1} → ${r.status}`);
    }
    expect((await request(srv).get('/v1/admin/me').set('Authorization', `Bearer ${token}`)).status).toBe(429);
    const v = await user('STAFF');
    const other = await request(srv).post('/v1/admin/auth/login').set('Origin', ADMIN).set('Content-Type', 'application/json').send({ email: v.email, password: PASSWORD });
    expect((await request(srv).get('/v1/admin/me').set('Authorization', `Bearer ${other.body.accessToken}`)).status).toBe(200);
  }, 60_000);
});
