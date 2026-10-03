// Staff & Permissions (api.md §4.10) and admin password reset, on real PostgreSQL + Redis.
import type { PrismaClient, UserRole } from '@prisma/client';
import type { Express } from 'express';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdminRouter } from '../../src/admin/router.js';
import { registerStaffRoutes } from '../../src/admin/staff-routes.js';
import { createApp } from '../../src/app.js';
import { adminAuthRouter } from '../../src/auth/admin-routes.js';
import { authRouter } from '../../src/auth/routes.js';
import { AuthService, DEFAULT_AUTH_TIMINGS } from '../../src/auth/service.js';
import { RedisSessionCache } from '../../src/auth/session-cache.js';
import { hashPassword } from '../../src/lib/password.js';
import type { RateLimiter } from '../../src/middleware/rateLimit.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { uniq } from '../helpers/fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const WEB = 'http://localhost:3000';
const ADMIN_ORIGIN = 'http://localhost:5173';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const PASSWORD = 'staff-password-123';
const NO_LIMIT: RateLimiter = { hit: async () => ({ count: 0, resetMs: 60_000 }) };

let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express;
const missingAudit: string[] = [];
type Who = { id: number; email: string; token: string };
let OWNER: Who;

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  const cache = new RedisSessionCache(redis);
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: WEB, adminUrl: ADMIN_ORIGIN });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log: pino({ level: 'silent' }), hasRecentStepUp: (sid) => service.hasRecentStepUp(sid), onMissingAudit: (req) => missingAudit.push(`${req.method} ${req.originalUrl}`) });
  registerStaffRoutes(admin, prisma, service);
  app = createApp({
    version: 't', origins: { storefront: [WEB], admin: [ADMIN_ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [
      authRouter({ ...deps, service, env: 'test', refreshMaxAgeS: DEFAULT_AUTH_TIMINGS.refreshIdleS, limiter: NO_LIMIT }),
      adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }),
      admin.router,
    ],
  });
  OWNER = await superAdmin();
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });

async function user(role: UserRole, o: { status?: 'ACTIVE' | 'BLOCKED'; password?: string | null } = {}) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  const u = await prisma.user.create({ data: { email, role, status: o.status ?? 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: o.password === null ? null : await hashPassword(o.password ?? PASSWORD) } });
  return { id: u.id, email };
}
async function adminLogin(email: string, password = PASSWORD) {
  return request(app).post('/v1/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email, password });
}
async function as(role: UserRole): Promise<Who> {
  const u = await user(role);
  const res = await adminLogin(u.email);
  expect(res.status).toBe(200);
  return { ...u, token: res.body.accessToken as string };
}
/** A SUPER_ADMIN with a fresh step-up (staff:manage changes need one). */
async function superAdmin(): Promise<Who> {
  const w = await as('SUPER_ADMIN');
  expect((await call('post', '/auth/step-up', w, { password: PASSWORD })).status).toBe(200);
  return w;
}
type Method = 'get' | 'post' | 'patch';
const call = (method: Method, path: string, who: { token: string } | null = OWNER, body?: object) => {
  let r = request(app)[method](`/v1/admin${path}`).set('Origin', ADMIN_ORIGIN);
  if (who) r = r.set('Authorization', `Bearer ${who.token}`);
  return body ? r.send(body) : r;
};
const me = (w: { token: string }) => call('get', '/me', w);
async function lastMail(to: string, template: string) {
  const rows = await prisma.$queryRaw<{ payload: { data: Record<string, unknown> } }[]>`
    SELECT payload FROM outbox_events WHERE event_type = 'email.auth' AND payload->>'to' = ${to} AND payload->>'template' = ${template} ORDER BY id DESC LIMIT 1`;
  return rows[0]?.payload.data ?? null;
}
const tokenOf = async (to: string, template = 'staff_invite') => {
  const link = new URL(String((await lastMail(to, template))!.link));
  expect(link.origin + link.pathname).toBe(`${ADMIN_ORIGIN}/reset-password`);
  return link.searchParams.get('token')!;
};
const reset = (token: string, password: string) => request(app).post('/v1/admin/auth/password/reset').set('Origin', ADMIN_ORIGIN).send({ token, password });

describe('list staff (GET /staff)', () => {
  it('SUPER_ADMIN lists staff without a step-up; customers are excluded; filters work', async () => {
    const fresh = await as('SUPER_ADMIN');   // no step-up
    const staff = await user('STAFF');
    const customer = await user('CUSTOMER');
    const blocked = await user('ADMIN', { status: 'BLOCKED' });
    const all = await call('get', '/staff?limit=100', fresh);
    expect(all.status).toBe(200);
    const ids = all.body.data.map((r: { id: number }) => r.id);
    expect(ids).toEqual(expect.arrayContaining([staff.id, blocked.id, fresh.id]));
    expect(ids).not.toContain(customer.id);
    expect(all.body.data.find((r: { id: number }) => r.id === fresh.id)).toMatchObject({ role: 'SUPER_ADMIN', status: 'ACTIVE', passwordSet: true, activeSessions: 1 });
    expect(all.headers['cache-control']).toBe('private, no-store');
    expect((await call('get', `/staff?q=${staff.email.toUpperCase()}`, fresh)).body.data.map((r: { id: number }) => r.id)).toEqual([staff.id]);
    expect((await call('get', '/staff?status=BLOCKED&limit=100', fresh)).body.data.every((r: { status: string }) => r.status === 'BLOCKED')).toBe(true);
    expect((await call('get', '/staff?role=STAFF&limit=100', fresh)).body.data.every((r: { role: string }) => r.role === 'STAFF')).toBe(true);
  });

  it('ADMIN and STAFF → 403 (staff:manage is SUPER_ADMIN only); no token → 401; bad query → 400', async () => {
    expect((await call('get', '/staff', await as('ADMIN'))).status).toBe(403);
    expect((await call('get', '/staff', await as('STAFF'))).status).toBe(403);
    expect((await call('get', '/staff', null)).status).toBe(401);
    expect((await call('get', '/staff?role=CUSTOMER')).status).toBe(400);
    expect((await call('get', '/staff?limit=101')).status).toBe(400);
  });
});

describe('add staff (POST /staff)', () => {
  it('needs a recent password check; then creates the account and emails a 72 h admin link; the link sets the password', async () => {
    const noStepUp = await as('SUPER_ADMIN');
    const email = `new${uniq()}@artq.in`;
    const first = await call('post', '/staff', noStepUp, { email, name: 'Sanju', role: 'STAFF' });
    expect([first.status, first.body.error.code]).toEqual([401, 'STEP_UP_REQUIRED']);

    const res = await call('post', '/staff', OWNER, { email: email.toUpperCase(), name: 'Sanju', role: 'STAFF' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email, name: 'Sanju', role: 'STAFF', status: 'ACTIVE', passwordSet: false, activeSessions: 0 });
    expect(await lastMail(email, 'staff_invite')).toMatchObject({ role: 'STAFF', name: 'Sanju' });
    const t = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: res.body.id }, orderBy: { id: 'desc' } });
    expect(t.expiresAt.getTime() - Date.now()).toBeGreaterThan(71 * 3600 * 1000);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'staff.create', entityId: String(res.body.id) } })).actorId).toBe(OWNER.id);

    expect((await adminLogin(email, 'anything-at-all')).status).toBe(401);   // no password yet
    const token = await tokenOf(email);
    const short = await reset(token, 'elevenchars');                          // staff minimum is 12
    expect(short.status).toBe(400);
    expect((await reset(token, 'twelve-chars-ok')).status).toBe(200);        // the short attempt did not burn the link
    expect((await reset(token, 'twelve-chars-ok')).body.error.code).toBe('TOKEN_INVALID');   // single use
    const login = await adminLogin(email, 'twelve-chars-ok');
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ role: 'STAFF', emailVerified: true });
  });

  it('promotes an existing customer (same login, existing password keeps working); case-insensitive email', async () => {
    const c = await user('CUSTOMER');
    expect((await adminLogin(c.email)).status).toBe(401);
    const res = await call('post', '/staff', OWNER, { email: c.email.toUpperCase(), name: 'Promoted', role: 'ADMIN' });
    expect([res.status, res.body.id, res.body.role]).toEqual([201, c.id, 'ADMIN']);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'staff.create', entityId: String(c.id) } })).after).toMatchObject({ promotedCustomer: true });
    expect((await adminLogin(c.email)).status).toBe(200);
  });

  it.each([
    ['already staff', async () => ({ email: (await user('STAFF')).email, name: 'X', role: 'STAFF' }), 409, 'STAFF_EXISTS'],
    ['a blocked customer', async () => ({ email: (await user('CUSTOMER', { status: 'BLOCKED' })).email, name: 'X', role: 'STAFF' }), 409, 'ACCOUNT_BLOCKED'],
    ['role CUSTOMER', async () => ({ email: `x${uniq()}@artq.in`, name: 'X', role: 'CUSTOMER' }), 400, 'VALIDATION_ERROR'],
    ['no name', async () => ({ email: `x${uniq()}@artq.in`, role: 'STAFF' }), 400, 'VALIDATION_ERROR'],
    ['bad email', async () => ({ email: 'not-an-email', name: 'X', role: 'STAFF' }), 400, 'VALIDATION_ERROR'],
    ['an extra field', async () => ({ email: `x${uniq()}@artq.in`, name: 'X', role: 'STAFF', password: 'set-it-for-them' }), 400, 'VALIDATION_ERROR'],
  ])('%s → %s %s', async (_l, body, status, code) => {
    const payload = await body();
    const before = await prisma.user.count();
    const res = await call('post', '/staff', OWNER, payload);
    expect([res.status, res.body.error.code]).toEqual([status, code]);
    expect(await prisma.user.count()).toBe(before);
  });

  it('the same limits as the form: 120-character name / 160-character email pass, one more → 400 on that field with the form\'s message', async () => {
    const email160 = (p: string) => `${p}${'a'.repeat(160 - '@artq.in'.length - p.length)}@artq.in`;
    expect((await call('post', '/staff', OWNER, { email: email160('b'), name: 'n'.repeat(120), role: 'STAFF' })).status).toBe(201);
    const over = await call('post', '/staff', OWNER, { email: `x${email160('c')}`, name: 'n'.repeat(121), role: 'STAFF' });
    expect(over.status).toBe(400);
    expect(over.body.error.details).toEqual([
      { location: 'body', path: 'email', message: 'Use at most 160 characters' },
      { location: 'body', path: 'name', message: 'Use at most 120 characters' },
    ]);
  });

  it('ADMIN cannot add staff (403, audited); two concurrent adds of one email create one account', async () => {
    const admin = await as('ADMIN');
    expect((await call('post', '/staff', admin, { email: `x${uniq()}@artq.in`, name: 'X', role: 'SUPER_ADMIN' })).status).toBe(403);
    expect(await prisma.auditLog.count({ where: { actorId: admin.id, action: 'security.admin_rejected' } })).toBe(1);
    const email = `race${uniq()}@artq.in`;
    const r = await Promise.all([1, 2, 3].map(() => call('post', '/staff', OWNER, { email, name: 'Race', role: 'STAFF' })));
    expect(r.map((x) => x.status).sort()).toEqual([201, 409, 409]);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });
});

describe('change role / remove access (PATCH /staff/:id)', () => {
  it('a role change ends the person\'s admin sessions at once and is audited with before/after', async () => {
    const target = await as('ADMIN');
    expect((await me(target)).status).toBe(200);
    const res = await call('patch', `/staff/${target.id}`, OWNER, { role: 'STAFF' });
    expect(res.body).toMatchObject({ role: 'STAFF', activeSessions: 0 });
    expect((await me(target)).status).toBe(401);
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'staff.role_change', entityId: String(target.id) } });
    expect([a.before, a.after]).toEqual([{ role: 'ADMIN', name: null }, { role: 'STAFF' }]);
    const again = await adminLogin(target.email);
    expect(again.body.user.role).toBe('STAFF');
  });

  it('role CUSTOMER removes admin access: 204, gone from the list, admin login refused', async () => {
    const target = await as('STAFF');
    expect((await call('patch', `/staff/${target.id}`, OWNER, { role: 'CUSTOMER' })).status).toBe(204);
    expect((await me(target)).status).toBe(401);
    expect((await adminLogin(target.email)).body.error.code).toBe('INVALID_CREDENTIALS');
    expect((await call('get', `/staff?q=${target.email}`)).body.data).toEqual([]);
    expect(await prisma.auditLog.count({ where: { action: 'staff.remove', entityId: String(target.id) } })).toBe(1);
    expect((await call('patch', `/staff/${target.id}`, OWNER, { name: 'x' })).status).toBe(404);   // no longer staff
  });

  it('rename only keeps sessions; you may rename yourself but not change your own role', async () => {
    const target = await as('STAFF');
    expect((await call('patch', `/staff/${target.id}`, OWNER, { name: 'Sanju P' })).body).toMatchObject({ name: 'Sanju P', role: 'STAFF', activeSessions: 1 });
    expect((await me(target)).status).toBe(200);
    expect((await call('patch', `/staff/${OWNER.id}`, OWNER, { name: 'Owner' })).status).toBe(200);
    const self = await call('patch', `/staff/${OWNER.id}`, OWNER, { role: 'ADMIN' });
    expect([self.status, self.body.error.code]).toEqual([422, 'CANNOT_CHANGE_SELF']);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: OWNER.id } })).role).toBe('SUPER_ADMIN');
  });

  it('same role is a no-op rename path; unknown id / customer id → 404; empty body → 400', async () => {
    const target = await as('STAFF');
    expect((await call('patch', `/staff/${target.id}`, OWNER, { role: 'STAFF' })).body).toMatchObject({ role: 'STAFF', activeSessions: 1 });
    expect((await call('patch', '/staff/999999', OWNER, { role: 'STAFF' })).status).toBe(404);
    expect((await call('patch', `/staff/${(await user('CUSTOMER')).id}`, OWNER, { role: 'STAFF' })).status).toBe(404);
    expect((await call('patch', `/staff/${target.id}`, OWNER, {})).status).toBe(400);
    expect((await call('patch', `/staff/${target.id}`, OWNER, { role: 'OWNER' })).status).toBe(400);
  });
});

describe('block, unblock, sign out everywhere, password links', () => {
  it('block ends every session and refuses login; unblock restores it; both audited', async () => {
    const target = await as('ADMIN');
    const blocked = await call('post', `/staff/${target.id}/block`);
    expect(blocked.body).toMatchObject({ status: 'BLOCKED', activeSessions: 0 });
    expect((await me(target)).status).toBe(401);
    expect((await adminLogin(target.email)).body.error.code).toBe('ACCOUNT_BLOCKED');
    expect((await call('post', `/staff/${target.id}/block`)).body.error.code).toBe('INVALID_TRANSITION');
    expect((await call('post', `/staff/${target.id}/send-password-link`)).body.error.code).toBe('INVALID_TRANSITION');
    expect((await call('post', `/staff/${target.id}/unblock`)).body).toMatchObject({ status: 'ACTIVE' });
    expect((await adminLogin(target.email)).status).toBe(200);
    expect((await call('post', `/staff/${target.id}/unblock`)).body.error.code).toBe('INVALID_TRANSITION');
    expect(await prisma.auditLog.count({ where: { entityId: String(target.id), action: { in: ['staff.block', 'staff.unblock'] } } })).toBe(2);
  });

  it('sign out everywhere ends the sessions but keeps the account active', async () => {
    const target = await as('STAFF');
    expect((await call('post', `/staff/${target.id}/revoke-sessions`)).body).toMatchObject({ status: 'ACTIVE', activeSessions: 0 });
    expect((await me(target)).status).toBe(401);
    expect((await adminLogin(target.email)).status).toBe(200);
  });

  it('none of these work on yourself, on customers or on unknown ids', async () => {
    for (const action of ['block', 'unblock', 'revoke-sessions', 'send-password-link']) {
      expect((await call('post', `/staff/${OWNER.id}/${action}`)).body.error.code).toBe('CANNOT_CHANGE_SELF');
      expect((await call('post', `/staff/999999/${action}`)).status).toBe(404);
      expect((await call('post', `/staff/${(await user('CUSTOMER')).id}/${action}`)).status).toBe(404);
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: OWNER.id } })).status).toBe('ACTIVE');
  });

  it('password links: a fresh link each time, at most 5 per account per hour (the invite counts)', async () => {
    const res = await call('post', '/staff', OWNER, { email: `links${uniq()}@artq.in`, name: 'Links', role: 'STAFF' });
    const first = await tokenOf(res.body.email);
    for (let i = 0; i < 4; i++) expect((await call('post', `/staff/${res.body.id}/send-password-link`)).status).toBe(200);
    expect(await tokenOf(res.body.email)).not.toBe(first);
    const sixth = await call('post', `/staff/${res.body.id}/send-password-link`);
    expect([sixth.status, sixth.body.error.code]).toEqual([429, 'RATE_LIMITED']);
    expect(await prisma.passwordResetToken.count({ where: { userId: res.body.id } })).toBe(5);
  });
});

describe('the last SUPER_ADMIN', () => {
  it('two Super Admins demoting or blocking each other at the same time: exactly one remains', async () => {
    for (const action of ['demote', 'block'] as const) {
      // only these two are active Super Admins for this check
      const [a, b] = [await superAdmin(), await superAdmin()];
      await prisma.user.updateMany({ where: { role: 'SUPER_ADMIN', id: { notIn: [a.id, b.id] } }, data: { role: 'ADMIN' } });
      const go = (from: Who, to: Who) => action === 'demote' ? call('patch', `/staff/${to.id}`, from, { role: 'ADMIN' }) : call('post', `/staff/${to.id}/block`, from);
      const r = await Promise.all([go(a, b), go(b, a)]);
      expect(r.filter((x) => x.status === 200)).toHaveLength(1);
      // the loser is refused by the guard, or finds its own session already ended by the winner
      expect(r.filter((x) => x.status !== 200).map((x) => x.body.error.code)).toEqual([expect.stringMatching(/^(LAST_SUPER_ADMIN|SESSION_INVALID|UNAUTHENTICATED)$/)]);
      expect(await prisma.user.count({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE' } })).toBe(1);
    }
    OWNER = await superAdmin();   // later tests need a Super Admin of their own
  });
});

describe('admin forgot / reset password (/admin/auth/password/*)', () => {
  const forgot = (email: string) => request(app).post('/v1/admin/auth/password/forgot').set('Origin', ADMIN_ORIGIN).send({ email });

  it('staff get a 30-minute link to the admin app; customers, unknown and blocked accounts get nothing; same response', async () => {
    const staff = await user('STAFF');
    const customer = await user('CUSTOMER');
    const blocked = await user('STAFF', { status: 'BLOCKED' });
    for (const e of [staff.email, customer.email, blocked.email, `nobody${uniq()}@artq.in`]) {
      const res = await forgot(e);
      expect([res.status, res.body]).toEqual([200, { ok: true }]);
    }
    const token = await tokenOf(staff.email, 'password_reset');
    expect(await lastMail(customer.email, 'password_reset')).toBeNull();
    expect(await lastMail(blocked.email, 'password_reset')).toBeNull();
    const t = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: staff.id } });
    expect(t.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(1800 * 1000);
    expect((await reset(token, 'a-brand-new-password')).status).toBe(200);
    expect((await adminLogin(staff.email, 'a-brand-new-password')).status).toBe(200);
    expect((await adminLogin(staff.email)).status).toBe(401);
  });

  it('bad token → 422 TOKEN_INVALID; malformed body → 400; storefront origin refused', async () => {
    expect((await reset('x'.repeat(43), 'long-enough-password')).body.error.code).toBe('TOKEN_INVALID');
    expect((await reset('short', 'long-enough-password')).status).toBe(400);
    expect((await request(app).post('/v1/admin/auth/password/forgot').set('Origin', ADMIN_ORIGIN).send({ email: 'x' })).status).toBe(400);
    expect((await request(app).post('/v1/admin/auth/password/forgot').set('Origin', WEB).send({ email: 'a@b.in' })).status).toBe(403);
  });

  it('the storefront reset page cannot give a staff account a short password', async () => {
    const staff = await user('ADMIN');
    await request(app).post('/v1/auth/password/forgot').set('Origin', WEB).send({ email: staff.email });
    const link = new URL(String((await lastMail(staff.email, 'password_reset'))!.link));
    const token = link.searchParams.get('token')!;
    const short = await request(app).post('/v1/auth/password/reset').set('Origin', WEB).send({ token, password: 'eight-c1' });
    expect([short.status, short.body.error.details[0].path]).toEqual([400, 'password']);
    expect((await request(app).post('/v1/auth/password/reset').set('Origin', WEB).send({ token, password: 'twelve-char1' })).status).toBe(200);
  });
});

describe('audit', () => {
  it('every successful staff mutation in this file recorded an audit entry', () => {
    expect(missingAudit).toEqual([]);
  });
});
