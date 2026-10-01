import { Router } from 'express';
import request from 'supertest';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../src/app.js';
import { AppError } from '../src/lib/errors.js';
import { originGuard } from '../src/middleware/originGuard.js';
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
  return r;
}
const app = (over: Partial<AppDeps> = {}) => createApp({ version: 'test', corsOrigins: ORIGINS, readiness: { database: ok, redis: ok }, routes: [testRoutes()], ...over });

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
    const res = await request(app()).post('/v1/echo').send({ name: 'resin', qty: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ got: { name: 'resin', qty: 2 } });
  });
  it('rejects form-encoded, multipart and text/plain with 415', async () => {
    for (const [type, body] of [['application/x-www-form-urlencoded', 'name=resin&qty=2'], ['text/plain', 'hello'], ['multipart/form-data; boundary=x', '--x--']]) {
      const res = await request(app()).post('/v1/echo').set('Content-Type', type).send(body);
      expect(res.status).toBe(415);
      expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
  });
  it('allows a bodyless POST', async () => {
    expect((await request(app()).post('/v1/empty')).status).toBe(200);
  });
  it('malformed JSON → 400 INVALID_JSON', async () => {
    const res = await request(app()).post('/v1/echo').set('Content-Type', 'application/json').send('{"name":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
  it('body over 1 MB → 413', async () => {
    const res = await request(app()).post('/v1/echo').send({ name: 'x'.repeat(1_100_000), qty: 1 });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('validation (strict schemas)', () => {
  it('rejects unknown keys', async () => {
    const res = await request(app()).post('/v1/echo').send({ name: 'resin', qty: 2, price: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].location).toBe('body');
  });
  it('rejects missing and invalid fields with one detail each', async () => {
    const res = await request(app()).post('/v1/echo').send({ qty: -1 });
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
