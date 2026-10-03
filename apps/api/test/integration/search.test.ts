// Task 3.7: GET /v1/search (logged, "did you mean") and GET /v1/search/suggest (typo-tolerant, rate limited).
import { NO_STORE } from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { RateLimiter } from '../../src/middleware/rateLimit.js';
import { storefrontRouter } from '../../src/storefront/routes.js';
import { normalizeQuery } from '../../src/storefront/search.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { startPostgres, type Service } from '../helpers/services.js';
import { liveProduct } from '../helpers/storefront-fixtures.js';

const CDN = (key: string) => `https://cdn.test/${key}`;
let pg: Service, db: TestDb, prisma: PrismaClient, app: Express;
const counts = new Map<string, number>();
const limiter: RateLimiter = { hit: async (key) => { const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return { count: n, resetMs: 60_000 }; } };
const build = (o: { db?: PrismaClient; logErrors?: unknown[] } = {}) => createApp({
  version: 't', origins: { storefront: ['http://localhost:3000'], admin: ['http://localhost:5173'] }, readiness: { database: async () => {}, redis: async () => {} },
  routes: [storefrontRouter({ prisma: o.db ?? prisma, mediaUrl: CDN, limiter, onSearchLogError: (e) => o.logErrors?.push(e) })],
});
beforeAll(async () => {
  pg = await startPostgres();
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  app = build();
  const resins = await prisma.productType.create({ data: { name: 'Resins', slug: 'resins' } });
  const art = await prisma.category.create({ data: { typeId: resins.id, name: 'Art Resin', slug: 'art-resin' } });
  const frames = await prisma.productType.create({ data: { name: 'Wooden Frames', slug: 'wooden-frames', tileLinkUrl: '/category/teak' } });
  const teak = await prisma.category.create({ data: { typeId: frames.id, name: 'Teak Frames', slug: 'teak' } });
  await liveProduct(prisma, { typeId: resins.id, categoryId: art.id, name: 'Ultra Clear Epoxy Resin', variants: [{ price: 49_900 }] });
  await liveProduct(prisma, { typeId: resins.id, categoryId: art.id, name: 'Deep Pour Resin', variants: [{ price: 99_900 }] });
  await liveProduct(prisma, { typeId: frames.id, categoryId: teak.id, name: 'Butterfly Frame', variants: [{ price: 29_900 }] });
  await liveProduct(prisma, { typeId: frames.id, categoryId: teak.id, name: 'Hidden Draft Resin Frame', status: 'DRAFT' });
  await prisma.category.create({ data: { typeId: resins.id, name: 'Resin Tools (empty)', slug: 'resin-tools' } });   // no live products
}, 180_000);
afterAll(async () => { await db?.drop(); await pg?.stop(); });
const ip = () => `192.0.2.${Math.floor(Math.random() * 250)}`;

describe('GET /v1/search', () => {
  it('finds by word prefixes, filters like the listing, never cached, and logs the query (normalised) with its result count', async () => {
    const before = await prisma.searchLog.count();
    const res = await request(app).get('/v1/search?q=  Deep%20PO  &sort=relevance');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(NO_STORE);
    expect(res.body).toMatchObject({ query: 'Deep PO', suggestion: null, meta: { total: 1 } });
    expect(res.body.data.map((c: { name: string }) => c.name)).toEqual(['Deep Pour Resin']);
    expect((await request(app).get('/v1/search?q=resin&maxPrice=50000')).body.data.map((c: { name: string }) => c.name)).toEqual(['Ultra Clear Epoxy Resin']);
    const logs = await prisma.searchLog.findMany({ where: { id: { gt: BigInt(0) } }, orderBy: { id: 'asc' }, skip: before });
    expect(logs.map((l) => [l.query, l.normalized, l.resultsCount])).toEqual([['Deep PO', 'deep po', 1], ['resin', 'resin', 1]]);
  });

  it('later pages (Load more) are not logged again; drafts never match', async () => {
    const before = await prisma.searchLog.count();
    const res = await request(app).get('/v1/search?q=resin&page=2&limit=1');
    expect(res.body.meta.total).toBe(2);   // the draft "Hidden Draft Resin Frame" is not counted
    expect(await prisma.searchLog.count()).toBe(before);
  });

  it('nothing found → suggests the closest product name; nothing close → no suggestion', async () => {
    expect((await request(app).get('/v1/search?q=butterfli')).body).toMatchObject({ meta: { total: 0 }, suggestion: 'Butterfly Frame' });
    expect((await request(app).get('/v1/search?q=zzqqxx')).body).toMatchObject({ meta: { total: 0 }, suggestion: null });
  });

  it('a query is required (400 with the shared message); the listing limits apply', async () => {
    for (const qs of ['', 'q=%20%20', 'type=resins']) {
      const res = await request(app).get(`/v1/search?${qs}`);
      expect(res.status, qs).toBe(400);
      expect(res.body.error.details).toContainEqual(expect.objectContaining({ path: 'q' }));
    }
    expect((await request(app).get(`/v1/search?q=${'x'.repeat(101)}`)).status).toBe(400);
    expect((await request(app).get(`/v1/search?q=${'x'.repeat(100)}`)).status).toBe(200);
  });

  it('the search log failing does not fail the search (reported instead)', async () => {
    const errors: unknown[] = [];
    await prisma.$executeRawUnsafe(`ALTER TABLE search_logs RENAME TO search_logs_away`);
    try {
      const res = await request(build({ logErrors: errors })).get('/v1/search?q=resin');
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(2);
      expect(errors).toHaveLength(1);
    } finally { await prisma.$executeRawUnsafe(`ALTER TABLE search_logs_away RENAME TO search_logs`); }
  });
});

describe('GET /v1/search/suggest', () => {
  const suggest = (q: string, from = ip()) => request(app).get(`/v1/search/suggest?q=${encodeURIComponent(q)}`).set('X-Forwarded-For', from);

  it('products by word prefix, with image and from-price; types and categories that have live products', async () => {
    const res = await suggest('res');
    expect(res.status).toBe(200);
    expect(res.body.products.map((p: { name: string }) => p.name).sort()).toEqual(['Deep Pour Resin', 'Ultra Clear Epoxy Resin']);
    expect(res.body.products[0]).toMatchObject({ slug: expect.any(String), fromPrice: expect.any(Number) });
    expect(res.body.products[0].image.url).toMatch(/^https:\/\/cdn\.test\//);
    expect(res.body.types).toEqual([{ slug: 'resins', name: 'Resins', href: '/type/resins' }]);
    expect(res.body.categories).toEqual([{ slug: 'art-resin', name: 'Art Resin', typeName: 'Resins' }]);   // the empty category is left out
  });

  it('typo-tolerant ("resn", "butterfli"); a type with a tile link uses it', async () => {
    expect((await suggest('resn')).body.products.length).toBeGreaterThan(0);
    expect((await suggest('butterfli')).body.products.map((p: { name: string }) => p.name)).toEqual(['Butterfly Frame']);
    expect((await suggest('wooden')).body.types).toEqual([{ slug: 'wooden-frames', name: 'Wooden Frames', href: '/category/teak' }]);
  });

  it('fewer than 2 characters → 400 "Type at least 2 characters"; exactly 2 is fine; symbols only → empty', async () => {
    const one = await suggest('r');
    expect(one.status).toBe(400);
    expect(one.body.error.details[0].message).toBe('Type at least 2 characters');
    expect((await suggest('re')).status).toBe(200);
    expect((await suggest('%%')).body).toEqual({ products: [], categories: [], types: [] });
  });

  it('60 suggestions a minute per network; the 61st → 429', async () => {
    const from = '198.18.0.1';   // its own network (the other tests draw from 192.0.2.x), so no other test spends this budget
    for (let i = 0; i < 60; i++) expect((await suggest('re', from)).status).toBe(200);
    expect((await suggest('re', from)).status).toBe(429);
  });

  it('normalised queries: lowercase, accents and extra spaces removed', () => {
    expect(normalizeQuery('  Pâte   À  Modeler ')).toBe('pate a modeler');
  });
});
