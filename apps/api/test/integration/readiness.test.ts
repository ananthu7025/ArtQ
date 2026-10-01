import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { makeReadinessChecks } from '../../src/lib/readiness.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

let pg: Service, rd: Service;
beforeAll(async () => { [pg, rd] = await Promise.all([startPostgres(), startRedis()]); }, 120_000);
afterAll(async () => { await Promise.all([pg?.stop(), rd?.stop()]); });

const appWith = (dbUrl: string, redisUrl: string) => {
  const prisma = new PrismaClient({ datasourceUrl: dbUrl });
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  redis.on('error', () => {});
  const app = createApp({ version: 'it', corsOrigins: ['http://localhost:3000'], readiness: makeReadinessChecks(prisma, redis), readinessTimeoutMs: 3000 });
  return { app, close: async () => { await prisma.$disconnect(); redis.disconnect(); } };
};

describe('/health/ready against real PostgreSQL 16 and Redis', () => {
  it('ready when both are up (happy path)', async () => {
    const { app, close } = appWith(pg.url, rd.url);
    const res = await request(app).get('/health/ready');
    await close();
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ database: { ok: true }, redis: { ok: true } });
  });
  it('503 when Redis is unreachable', async () => {
    const { app, close } = appWith(pg.url, 'redis://127.0.0.1:1');
    const res = await request(app).get('/health/ready');
    await close();
    expect(res.status).toBe(503);
    expect(res.body.checks.database.ok).toBe(true);
    expect(res.body.checks.redis.ok).toBe(false);
  });
  it('503 when PostgreSQL is unreachable', async () => {
    const { app, close } = appWith('postgresql://postgres:postgres@127.0.0.1:1/none', rd.url);
    const res = await request(app).get('/health/ready');
    await close();
    expect(res.status).toBe(503);
    expect(res.body.checks.database.ok).toBe(false);
    expect(res.body.checks.redis.ok).toBe(true);
  });
  it('503 when the database credentials are wrong', async () => {
    const u = new URL(pg.url); u.password = 'definitely-wrong';
    const bad = u.toString();
    expect(bad).not.toBe(pg.url);
    const { app, close } = appWith(bad, rd.url);
    const res = await request(app).get('/health/ready');
    await close();
    // embedded PostgreSQL uses password auth; CI service containers do too
    expect(res.status).toBe(503);
  });
});
