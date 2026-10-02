// Task 1.5: rate limits (api.md §6) with the real Redis limiter on the real auth routes.
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { cookieSpec } from '../../src/auth/cookies.js';
import { authRouter } from '../../src/auth/routes.js';
import { AuthService, DEFAULT_AUTH_TIMINGS } from '../../src/auth/service.js';
import { MemorySessionCache } from '../../src/auth/session-cache.js';
import { clientKey, RATE_LIMITS, RedisRateLimiter, type RateLimiter } from '../../src/middleware/rateLimit.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { uniq } from '../helpers/fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const ORIGIN = 'http://localhost:3000';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const COOKIE = cookieSpec('refresh', 'test').name;

let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis;
beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });

function build(limiter: RateLimiter, onError?: (e: unknown) => void): Express {
  const cache = new MemorySessionCache();
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: ORIGIN, adminUrl: 'http://localhost:5173' });
  return createApp({
    version: 't', origins: { storefront: [ORIGIN], admin: ['http://localhost:5173'] }, readiness: { database: async () => {}, redis: async () => {} },
    rateLimiter: limiter, ...(onError ? { onRateLimitError: onError } : {}),
    routes: [authRouter({ prisma, cache, jwt: JWT, service, env: 'test', refreshMaxAgeS: DEFAULT_AUTH_TIMINGS.refreshIdleS, limiter, ...(onError ? { onRateLimitError: onError } : {}) })],
  });
}
/** A fresh client address per test so buckets never leak between tests. */
const ip = () => `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const post = (app: Express, path: string, body: object, from: string, cookie?: string) => {
  let r = request(app).post(`/v1${path}`).set('Origin', ORIGIN).set('Content-Type', 'application/json').set('X-Forwarded-For', from);
  if (cookie) r = r.set('Cookie', `${COOKIE}=${cookie}`);
  return r.send(body);
};
const statuses = async (n: number, f: () => Promise<request.Response>) => { const out: number[] = []; for (let i = 0; i < n; i++) out.push((await f()).status); return out; };

describe('auth rate limits on Redis', () => {
  it('login: 10/min per IP (11th → 429 with Retry-After); another IP is unaffected; the key expires', async () => {
    const app = build(new RedisRateLimiter(redis));
    const a = ip();
    const s = await statuses(11, () => post(app, '/auth/login', { email: 'nobody@example.com', password: 'whatever-1' }, a));
    expect(s.slice(0, 10).every((x) => x === 401)).toBe(true);
    const blocked = await post(app, '/auth/login', { email: 'nobody@example.com', password: 'whatever-1' }, a);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect((await post(app, '/auth/login', { email: 'nobody@example.com', password: 'whatever-1' }, ip())).status).toBe(401);
    const ttl = await redis.pttl(`rl:auth-login:${a}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it('email-sending endpoints share 20/hour per IP (OTP request, signup, forgot password)', async () => {
    const app = build(new RedisRateLimiter(redis));
    const a = ip();
    await statuses(10, () => post(app, '/auth/otp/request', { email: `x${uniq()}@example.com`, purpose: 'LOGIN' }, a));
    await statuses(5, () => post(app, '/auth/password/forgot', { email: `x${uniq()}@example.com` }, a));
    const signups = await statuses(6, () => post(app, '/auth/signup', { name: 'N', email: `x${uniq()}@example.com`, password: 'long-enough-1', marketingOptIn: false }, a));
    expect(signups).toEqual([201, 201, 201, 201, 201, 429]);
    expect(await redis.pttl(`rl:auth-email:${a}`)).toBeGreaterThan(3_500_000);
  });

  it('verification endpoints: 30/min per IP', async () => {
    const app = build(new RedisRateLimiter(redis));
    const a = ip();
    const s = await statuses(31, () => post(app, '/auth/otp/verify', { email: 'nobody@example.com', purpose: 'LOGIN', code: '123456' }, a));
    expect(s.slice(0, 30).every((x) => x === 422)).toBe(true);
    expect(s[30]).toBe(429);
  });

  it('refresh: 30/min per session, not per IP; unknown cookies count against the IP', async () => {
    const app = build(new RedisRateLimiter(redis));
    const a = ip();
    // two sessions behind one IP (a family sharing a connection)
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      const email = `s${uniq()}@example.com`;
      await post(app, '/auth/signup', { name: 'S', email, password: 'long-enough-1', marketingOptIn: false }, ip());
      const [row] = await prisma.$queryRaw<{ code: string }[]>`SELECT payload->'data'->>'code' AS code FROM outbox_events WHERE payload->>'to' = ${email} ORDER BY id DESC LIMIT 1`;
      const v = await post(app, '/auth/signup/verify', { email, code: row!.code }, ip());
      tokens.push(([] as string[]).concat(v.headers['set-cookie'])[0]!.split(';')[0]!.split('=')[1]!);
    }
    // a client replaying one (grace-window) token 31 times exhausts only that session's budget
    await post(app, '/auth/refresh', {}, a, tokens[0]);
    const s = await statuses(30, () => post(app, '/auth/refresh', {}, a, tokens[0]));
    expect(s.slice(0, 29).every((x) => x === 200)).toBe(true);
    expect(s[29]).toBe(429);
    expect((await post(app, '/auth/refresh', {}, a, tokens[1])).status).toBe(200);
    const sid = (await prisma.refreshToken.findFirstOrThrow({ where: { tokenHash: { not: '' } }, orderBy: { issuedAt: 'asc' } })).sessionId;
    expect(await redis.exists(`rl:auth-refresh:s:${sid}`)).toBe(1);
    const garbage = await statuses(31, () => post(app, '/auth/refresh', {}, a, `garbage${uniq()}`));
    expect(garbage.slice(0, 30).every((x) => x === 401)).toBe(true);
    expect(garbage[30]).toBe(429);
  });

  it('the default 300/min per IP covers every route; /health is exempt', async () => {
    const app = build(new RedisRateLimiter(redis));
    const a = ip();
    await redis.set(`rl:default:${a}`, '300', 'PX', 60_000);         // pretend this IP already made 300 requests
    expect((await request(app).get('/v1/me').set('X-Forwarded-For', a)).status).toBe(429);
    expect((await request(app).get('/health').set('X-Forwarded-For', a)).status).toBe(200);
  });

  it('Redis down ⇒ requests are allowed and the failure is reported (lockouts in PostgreSQL still apply)', async () => {
    const dead = new Redis('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null, enableOfflineQueue: false });
    dead.on('error', () => {});
    const errors: unknown[] = [];
    const app = build(new RedisRateLimiter(dead), (e) => errors.push(e));
    const s = await statuses(12, () => post(app, '/auth/login', { email: 'nobody@example.com', password: 'whatever-1' }, ip()));
    expect(s.every((x) => x === 401)).toBe(true);
    expect(errors.length).toBeGreaterThanOrEqual(12);
    dead.disconnect();
  });

  it('the origin check rejects a cookie-route POST before any limiter or route work', async () => {
    const app = build(new RedisRateLimiter(redis));
    const noOrigin = await request(app).post('/v1/auth/login').set('Content-Type', 'application/json').set('X-Forwarded-For', ip()).send({});
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body.error.code).toBe('ORIGIN_REJECTED');
  });
});

describe('clientKey', () => {
  const k = (ip: string) => clientKey({ ip, socket: {} } as never);
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:abcd:12:1:2:3:4', '2001:db8:abcd:12::/64'],
    ['2001:db8:abcd:12::99', '2001:db8:abcd:12::/64'],
    ['2001:0db8:0000:0012:ffff::1', '2001:db8:0:12::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
  ])('%s → %s', (ip, key) => { expect(k(ip)).toBe(key); });

  it('two addresses in one /64 share a bucket; different /64s do not', () => {
    expect(k('2001:db8:1:2:aaaa::1')).toBe(k('2001:db8:1:2:bbbb::2'));
    expect(k('2001:db8:1:2::1')).not.toBe(k('2001:db8:1:3::1'));
  });

  it('documented limits', () => {
    expect(RATE_LIMITS).toMatchObject({ default: { limit: 300, windowS: 60 }, login: { limit: 10, windowS: 60 }, refresh: { limit: 30, windowS: 60 }, emailSend: { limit: 20, windowS: 3600 } });
  });
});
