import { Router } from 'express';
import request from 'supertest';
import { z } from 'zod';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createApp, type AppDeps } from '../src/app.js';
import { AppError } from '../src/lib/errors.js';
import { originGuard } from '../src/middleware/originGuard.js';
import { createServer } from 'node:http';
import express from 'express';
import { pino } from 'pino';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { MemoryRateLimiter, RATE_LIMITS, rateLimit, type RateLimiter } from '../src/middleware/rateLimit.js';
import { validate } from '../src/middleware/validate.js';

const ORIGINS = ['https://artq.in', 'https://admin.artq.in'];
const ok = async () => {};

function testRoutes() {
  const r = Router();
  r.post('/echo', validate({ body: z.strictObject({ name: z.string().min(1), qty: z.number().int().positive() }) }), (req, res) => { res.json({ got: req.body }); });
  r.get('/items', validate({ query: z.strictObject({ page: z.coerce.number().int().min(1).default(1) }) }), (req, res) => { res.json({ page: (req.query as { page: number }).page }); });
  r.post('/empty', (_req, res) => { res.json({ ok: true }); });
  r.post('/cookie-route', originGuard(ORIGINS), (_req, res) => { res.json({ ok: true }); });
  r.get('/cookie-route', originGuard(ORIGINS), (_req, res) => { res.json({ ok: true }); });
  r.get('/boom', () => { throw new Error('secret internal detail'); });
  r.get('/conflict', (_req, _res, next) => next(new AppError(409, 'OUT_OF_STOCK', 'Only 2 left', { available: 2 })));
  r.post('/webhooks/test', (_req, res) => { res.json({ ok: true }); });
  r.post('/webhooksfake', (_req, res) => { res.json({ ok: true }); });
  r.post('/admin/thing', (_req, res) => { res.json({ ok: true }); });
  for (const m of ['put', 'patch', 'delete'] as const) r[m]('/echo', (_req, res) => { res.json({ ok: true }); });
  return r;
}
const SF = 'https://artq.in';
const ADMIN = 'https://admin.artq.in';
const app = (over: Partial<AppDeps> = {}) => createApp({ version: 'test', origins: { storefront: [SF], admin: [ADMIN] }, readiness: { database: ok, redis: ok }, routes: [testRoutes()], ...over });
const sfPost = (path: string, a = app()) => request(a).post(path).set('Origin', SF);

describe('health', () => {
  it('GET /health → 200, no-store, security headers, no x-powered-by', async () => {
    const res = await request(app()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'api', version: 'test' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
  it('ready when every dependency answers', async () => {
    const res = await request(app()).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', checks: { database: { ok: true }, redis: { ok: true } } });
  });
  it('not ready (503) when a dependency fails', async () => {
    const res = await request(app({ readiness: { database: ok, redis: async () => { throw new Error('ECONNREFUSED'); } } })).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.checks.redis).toEqual({ ok: false, error: 'ECONNREFUSED' });
    expect(res.body.checks.database).toEqual({ ok: true });
  });
  it('not ready (503) when a dependency hangs past the timeout', async () => {
    const hang = () => new Promise<void>(() => {});
    const res = await request(app({ readiness: { database: hang }, readinessTimeoutMs: 50 })).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.checks.database.error).toMatch(/timed out/);
  });
});

describe('request id', () => {
  it('generates one when absent', async () => {
    const res = await request(app()).get('/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('echoes a well-formed incoming id', async () => {
    const res = await request(app()).get('/health').set('X-Request-Id', 'edge-abc12345');
    expect(res.headers['x-request-id']).toBe('edge-abc12345');
  });
  it('replaces a malformed or oversized incoming id', async () => {
    for (const bad of ['short', 'has spaces in it', 'x'.repeat(65), '<script>alert(1)</script>']) {
      const res = await request(app()).get('/health').set('X-Request-Id', bad);
      expect(res.headers['x-request-id']).not.toBe(bad);
    }
  });
});

describe('errors', () => {
  it('unknown route → 404 NOT_FOUND in the standard shape', async () => {
    const res = await request(app()).get('/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'No route for GET /v1/nope' } });
  });
  it('AppError keeps status, code and details', async () => {
    const res = await request(app()).get('/v1/conflict');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'OUT_OF_STOCK', message: 'Only 2 left', details: { available: 2 } } });
  });
  it('unexpected error → 500 INTERNAL without leaking internals', async () => {
    const res = await request(app()).get('/v1/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});

describe('JSON-only bodies', () => {
  it('accepts application/json', async () => {
    const res = await sfPost('/v1/echo').send({ name: 'resin', qty: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ got: { name: 'resin', qty: 2 } });
  });
  it('rejects form-encoded, multipart and text/plain with 415', async () => {
    for (const [type, body] of [['application/x-www-form-urlencoded', 'name=resin&qty=2'], ['text/plain', 'hello'], ['multipart/form-data; boundary=x', '--x--']]) {
      const res = await sfPost('/v1/echo').set('Content-Type', type).send(body);
      expect(res.status).toBe(415);
      expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
  });
  it('allows a bodyless POST', async () => {
    expect((await sfPost('/v1/empty')).status).toBe(200);
  });
  it('malformed JSON → 400 INVALID_JSON', async () => {
    const res = await sfPost('/v1/echo').set('Content-Type', 'application/json').send('{"name":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
  it('body over 1 MB → 413', async () => {
    const res = await sfPost('/v1/echo').send({ name: 'x'.repeat(1_100_000), qty: 1 });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('validation (strict schemas)', () => {
  it('rejects unknown keys', async () => {
    const res = await sfPost('/v1/echo').send({ name: 'resin', qty: 2, price: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].location).toBe('body');
  });
  it('rejects missing and invalid fields with one detail each', async () => {
    const res = await sfPost('/v1/echo').send({ qty: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['name', 'qty']);
  });
  it('coerces and defaults query parameters', async () => {
    expect((await request(app()).get('/v1/items?page=3')).body).toEqual({ page: 3 });
    expect((await request(app()).get('/v1/items')).body).toEqual({ page: 1 });
  });
  it('rejects bad and unknown query parameters', async () => {
    expect((await request(app()).get('/v1/items?page=0')).status).toBe(400);
    expect((await request(app()).get('/v1/items?sort=x')).status).toBe(400);
  });
});

describe('origin guard (cookie routes)', () => {
  const post = (h: Record<string, string>) => { let r = request(app()).post('/v1/cookie-route'); for (const [k, v] of Object.entries(h)) r = r.set(k, v); return r; };
  it('allows an allow-listed origin', async () => {
    expect((await post({ Origin: 'https://artq.in', 'Sec-Fetch-Site': 'same-site' })).status).toBe(200);
  });
  it('rejects a missing origin', async () => {
    const res = await post({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORIGIN_REJECTED');
  });
  it('rejects a foreign origin even with a same-site fetch header', async () => {
    expect((await post({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-site' })).status).toBe(403);
  });
  it('rejects a lookalike origin', async () => {
    expect((await post({ Origin: 'https://artq.in.evil.example' })).status).toBe(403);
  });
  it('rejects Sec-Fetch-Site cross-site even with an allowed origin', async () => {
    expect((await post({ Origin: 'https://artq.in', 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
  });
  it('does not guard safe methods', async () => {
    expect((await request(app()).get('/v1/cookie-route')).status).toBe(200);
  });
});

describe('CORS (browser read permission only)', () => {
  it('preflight from an allowed origin gets credentials-enabled CORS headers', async () => {
    const res = await request(app()).options('/v1/echo').set('Origin', 'https://admin.artq.in').set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://admin.artq.in');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
  it('a disallowed origin is rejected with 403', async () => {
    const res = await request(app()).get('/health').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('server-to-server calls (no Origin) work without CORS headers', async () => {
    const res = await request(app()).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('app-wide origin policy (task 1.5)', () => {
  const send = (method: 'post' | 'put' | 'patch' | 'delete', path: string, origin?: string) => {
    let r = request(app())[method](path).set('Content-Type', 'application/json');
    if (origin) r = r.set('Origin', origin);
    return r.send('{}');
  };
  it.each(['post', 'put', 'patch', 'delete'] as const)('%s on a route without its own guard: missing/foreign Origin → 403', async (m) => {
    expect((await send(m, '/v1/echo')).body.error.code).toBe('ORIGIN_REJECTED');
    expect((await send(m, '/v1/echo', 'https://evil.example')).status).toBe(403);
    expect((await send(m, '/v1/echo', SF)).status).not.toBe(403);
  });
  it('webhooks are exempt (signature-authenticated), but only under /v1/webhooks/', async () => {
    expect((await send('post', '/v1/webhooks/test')).status).toBe(200);
    expect((await send('post', '/v1/webhooksfake')).status).toBe(403);
  });
  it('admin paths accept only admin origins; storefront paths only storefront origins', async () => {
    expect((await send('post', '/v1/admin/thing', ADMIN)).status).toBe(200);
    expect((await send('post', '/v1/admin/thing', SF)).status).toBe(403);
    expect((await send('post', '/v1/empty', ADMIN)).status).toBe(403);
  });
  it('case variations of the path cannot bypass the policy', async () => {
    expect((await send('post', '/V1/ECHO')).status).toBe(403);
    expect((await send('post', '/V1/Admin/thing', SF)).status).toBe(403);
    expect((await send('post', '/V1/WEBHOOKS/test')).status).toBe(200);
  });
  it('safe methods are not origin-checked', async () => {
    expect((await request(app()).get('/v1/items')).status).toBe(200);
    expect((await request(app()).head('/v1/items')).status).toBe(200);
  });
});

describe('default rate limit (api.md §6: 300/min/IP)', () => {
  it('allows 300 requests per minute per client, then 429 with Retry-After; /health is never limited', async () => {
    const a = createServer(app({ rateLimiter: new MemoryRateLimiter() })).listen(0);   // one server for all 300 calls
    onTestFinished(() => { a.close(); });
    for (let i = 0; i < 300; i++) {
      const r = await request(a).get('/v1/items').set('X-Forwarded-For', '203.0.113.7');
      if (r.status !== 200) throw new Error(`request ${i + 1} → ${r.status}`);
      if (i === 0) expect(r.headers).toMatchObject({ 'ratelimit-limit': '300', 'ratelimit-remaining': '299' });
    }
    const blocked = await request(a).get('/v1/items').set('X-Forwarded-For', '203.0.113.7');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatchObject({ code: 'RATE_LIMITED', details: { retryAfterSeconds: expect.any(Number) } });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.headers['ratelimit-remaining']).toBe('0');
    expect((await request(a).get('/v1/items').set('X-Forwarded-For', '203.0.113.8')).status).toBe(200);   // another client
    expect((await request(a).get('/health').set('X-Forwarded-For', '203.0.113.7')).status).toBe(200);
  });

  it('the window resets; a null key skips limiting', async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now);
    const mini = express();
    mini.set('trust proxy', 1);
    mini.get('/x', rateLimit({ limiter, name: 't', rule: { limit: 2, windowS: 60 } }), (_q, r) => { r.json({ ok: 1 }); });
    mini.get('/skip', rateLimit({ limiter, name: 's', rule: { limit: 0, windowS: 60 }, key: () => null }), (_q, r) => { r.json({ ok: 1 }); });
    mini.use(errorHandler(pino({ level: 'silent' })));
    const hit = () => request(mini).get('/x');
    expect([(await hit()).status, (await hit()).status, (await hit()).status]).toEqual([200, 200, 429]);
    now += 60_001;
    expect((await hit()).status).toBe(200);
    expect((await request(mini).get('/skip')).status).toBe(200);
    expect(RATE_LIMITS.default).toEqual({ limit: 300, windowS: 60 });
  });

  it('fails open (and reports) when the limiter is down', async () => {
    const errors: unknown[] = [];
    const broken: RateLimiter = { hit: async () => { throw new Error('redis down'); } };
    const res = await request(app({ rateLimiter: broken, onRateLimitError: (e) => errors.push(e) })).get('/v1/items');
    expect(res.status).toBe(200);
    expect(errors).toHaveLength(1);
  });
});

