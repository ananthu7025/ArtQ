// Task 3.2 (architecture.md §6.1): ✅ cache headers for every route group — only allow-listed public GETs are shared-
// cacheable, personal routes never are — and the Redis app cache for navigation/settings (TTL 300 s, dropped on admin
// writes and catalogue imports). Real PostgreSQL + Redis, the real routers, stand-ins for route groups not built yet.
import type { PrismaClient } from '@prisma/client';
import { Router, type Express, type Request, type Response } from 'express';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { createAdminRouter } from '../../src/admin/router.js';
import { createApp } from '../../src/app.js';
import { adminAuthRouter } from '../../src/auth/admin-routes.js';
import { authRouter } from '../../src/auth/routes.js';
import { AuthService, DEFAULT_AUTH_TIMINGS } from '../../src/auth/service.js';
import { RedisSessionCache } from '../../src/auth/session-cache.js';
import { registerTaxonomyRoutes } from '../../src/catalog/taxonomy-routes.js';
import { ImportService } from '../../src/imports/service.js';
import { APP_CACHE_TTL_S, RedisAppCache } from '../../src/lib/app-cache.js';
import { hashPassword } from '../../src/lib/password.js';
import type { RateLimiter } from '../../src/middleware/rateLimit.js';
import { storefrontRouter } from '../../src/storefront/routes.js';
import { webhookRouter } from '../../src/webhooks/inbox.js';
import { razorpayProvider } from '../../src/webhooks/provider.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { uniq } from '../helpers/fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';
import { liveProduct } from '../helpers/storefront-fixtures.js';

const WEB = 'http://localhost:3000';
const CDN = (key: string) => `https://cdn.test/${key}`;
const ADMIN_ORIGIN = 'http://localhost:5173';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const PUBLIC = 'public, max-age=0, s-maxage=60, stale-while-revalidate=60';
const NO_STORE = 'private, no-store';
const NO_LIMIT: RateLimiter = { hit: async () => ({ count: 0, resetMs: 60_000 }) };

let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express, appCache: RedisAppCache;
let adminToken: string, adminId: number;
const seen: Record<string, { cookie: boolean; auth: boolean }> = {};

/** Route groups that do not exist yet, mounted as stand-ins: each would happily set a cookie and read the caller's. */
function standIns(): Router {
  const r = Router();
  const echo = (name: string, status = 200) => (req: Request, res: Response) => {
    seen[name] = { cookie: Boolean(req.headers.cookie), auth: Boolean(req.headers.authorization) };
    res.cookie('aq_track', 'x').status(status).json({ name });
  };
  r.get('/pages/missing-page', echo('missing', 404));   // before /pages/:slug
  // /home, /products/:slug and its /availability are real routes (storefront router) and answer first.
  // /types/:slug, /categories/:slug, /techniques/:slug and /products are real too (task 3.5).
  for (const p of ['/types', '/techniques', '/pages/:slug', '/faqs', '/testimonials', '/reels', '/seo/sitemap-entries']) r.get(p, echo(p));
  for (const p of ['/me', '/me/orders', '/cart', '/checkout', '/orders/:n', '/uploads/:id']) r.get(p, echo(p));
  r.get('/reels-broken', () => { throw new Error('boom'); });
  return r;
}

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  appCache = new RedisAppCache(redis);
  const sessions = new RedisSessionCache(redis);
  const service = new AuthService(prisma, sessions, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: WEB, adminUrl: ADMIN_ORIGIN });
  const deps = { prisma, cache: sessions, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log: pino({ level: 'silent' }), hasRecentStepUp: (sid) => service.hasRecentStepUp(sid) });
  registerTaxonomyRoutes(admin, prisma, undefined, appCache);
  app = createApp({
    version: 't', origins: { storefront: [WEB], admin: [ADMIN_ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [
      authRouter({ ...deps, service, env: 'test', refreshMaxAgeS: DEFAULT_AUTH_TIMINGS.refreshIdleS, limiter: NO_LIMIT }),
      adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }),
      webhookRouter({ prisma, queue: null, providers: [razorpayProvider('whsec_test')], log: pino({ level: 'silent' }) }),
      storefrontRouter({ mediaUrl: CDN, prisma, cache: appCache, limiter: NO_LIMIT }),
      admin.router,
      standIns(),
    ],
  });
  const email = `owner${uniq()}@artq.in`;
  adminId = (await prisma.user.create({ data: { email, role: 'SUPER_ADMIN', status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword('cache-test-password-1') } })).id;
  adminToken = (await request(app).post('/v1/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email, password: 'cache-test-password-1' })).body.accessToken as string;
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });

const expectPublic = (res: request.Response) => {
  expect(res.headers['cache-control'], `${res.req.method} ${res.req.path}`).toBe(PUBLIC);
  expect(res.headers['set-cookie']).toBeUndefined();
  expect(res.headers.vary).toMatch(/Accept-Encoding/);
};
const expectNoStore = (res: request.Response) => { expect(res.headers['cache-control'], `${res.req.method} ${res.req.path} → ${res.status}`).toBe(NO_STORE); };
const adminCall = (method: 'post' | 'patch' | 'delete', path: string, body?: object) => {
  const r = request(app)[method](`/v1/admin${path}`).set('Origin', ADMIN_ORIGIN).set('Authorization', `Bearer ${adminToken}`);
  return body ? r.send(body) : r;
};
const menu = async () => ((await request(app).get('/v1/navigation')).body.types as { name: string; categories: { name: string }[] }[]).map((t) => t.name);

describe('✅ cache headers for every route group', () => {
  it('allow-listed public GETs (real and stand-in): public 60 s, no Set-Cookie even if the handler sets one, Vary: Accept-Encoding', async () => {
    const live = await liveProduct(prisma, { name: 'Cache Check' });
    const type = await prisma.productType.findUniqueOrThrow({ where: { id: live.typeId } });
    const category = await prisma.category.findUniqueOrThrow({ where: { id: live.categoryId } });
    const technique = await prisma.technique.create({ data: { name: `Tech ${uniq()}`, slug: `tech-${uniq()}` } });
    for (const p of ['/navigation', '/settings/public', '/home', '/types', `/types/${type.slug}`, `/categories/${category.slug}`, '/techniques', `/techniques/${technique.slug}`, '/products', `/products/${live.slug}`, '/pages/about', '/faqs', '/testimonials', '/reels', '/seo/sitemap-entries']) {
      const res = await request(app).get(`/v1${p}`).set('Cookie', 'aq_cart=c1; __Secure-aq_rt=r1').set('Authorization', 'Bearer abc');
      expect(res.status, p).toBe(200);
      expectPublic(res);
    }
    expectPublic(await request(app).head('/v1/navigation'));
    expectPublic(await request(app).get('/v1/NAVIGATION/'));            // Express matches case-insensitively, so does the policy
  });

  it('public handlers never see the caller\'s cookies or Authorization (a cached body cannot depend on them)', async () => {
    await request(app).get('/v1/faqs').set('Cookie', 'aq_cart=c1').set('Authorization', 'Bearer abc');
    expect(seen['/faqs']).toEqual({ cookie: false, auth: false });
    await request(app).get('/v1/uploads/9').set('Cookie', 'aq_cart=c1').set('Authorization', 'Bearer abc');
    expect(seen['/uploads/:id']).toEqual({ cookie: true, auth: true });   // personal routes still get them
  });

  it('personal and live routes are never shared-cacheable, even as a 200 GET', async () => {
    const live = await liveProduct(prisma, { name: 'Availability Check' });
    expectNoStore(await request(app).get(`/v1/products/${live.slug}/availability`).set('Cookie', 'aq_cart=c1'));   // live stock: real route
    expectNoStore(await request(app).get('/v1/pincodes/682001/serviceability'));   // real route (task 3.6)
    for (const p of ['/me', '/me/orders', '/cart', '/checkout', '/orders/AQ1001', '/uploads/9']) {
      const res = await request(app).get(`/v1${p}`).set('Cookie', 'aq_cart=c1');
      expect([200, 401], p).toContain(res.status);                    // /me is the real customer route (401 without a token)
      expectNoStore(res);
      if (res.status === 200) expect(res.headers['set-cookie']).toBeDefined();   // cookies still work where they belong
    }
  });

  it('auth, admin (even a successful admin GET), newsletter, webhooks: private, no-store', async () => {
    expectNoStore(await request(app).post('/v1/auth/login').set('Origin', WEB).send({ email: 'nobody@example.com', password: 'whatever-1' }));
    expectNoStore(await request(app).post('/v1/auth/refresh').set('Origin', WEB).send({}));
    expectNoStore(await request(app).get('/v1/admin/me'));
    const me = await request(app).get('/v1/admin/me').set('Authorization', `Bearer ${adminToken}`);
    expect(me.status).toBe(200);
    expectNoStore(me);
    const list = await request(app).get('/v1/admin/product-types').set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expectNoStore(list);
    expectNoStore(await request(app).post('/v1/newsletter/subscribe').set('Origin', WEB).send({ email: `n${uniq()}@example.com` }));
    expectNoStore(await request(app).post('/v1/webhooks/razorpay').set('Content-Type', 'application/json').send({}));
  });

  it('errors on public routes are not cached: 404, 500, writes to a public path, origin refusal, preflight, health, unknown routes', async () => {
    expectNoStore(await request(app).get('/v1/pages/missing-page'));
    const boom = await request(app).get('/v1/reels-broken');
    expect(boom.status).toBe(500);
    expectNoStore(boom);
    expectNoStore(await request(app).post('/v1/navigation').set('Origin', WEB).send({}));
    expectNoStore(await request(app).post('/v1/navigation').set('Origin', 'https://evil.example').send({}));
    expectNoStore(await request(app).options('/v1/navigation').set('Origin', WEB).set('Access-Control-Request-Method', 'GET'));
    expectNoStore(await request(app).get('/health'));
    expectNoStore(await request(app).get('/v1/no-such-route'));
  });

  it('a rate-limited public GET (429) is not cached', async () => {
    const blocked: RateLimiter = { hit: async () => ({ count: 10_000, resetMs: 30_000 }) };
    const limited = createApp({ version: 't', origins: { storefront: [WEB], admin: [ADMIN_ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} }, rateLimiter: blocked, routes: [storefrontRouter({ mediaUrl: CDN, prisma })] });
    const res = await request(limited).get('/v1/navigation');
    expect(res.status).toBe(429);
    expectNoStore(res);
  });

  it('a conditional GET answered 304 keeps the public header', async () => {
    const first = await request(app).get('/v1/settings/public');
    const again = await request(app).get('/v1/settings/public').set('If-None-Match', first.headers.etag as string);
    expect(again.status).toBe(304);
    expect(again.headers['cache-control']).toBe(PUBLIC);
  });
});

describe('Redis app cache (TTL 300 s, dropped on admin writes)', () => {
  it('serves the cached menu until an admin change; every kind of taxonomy write drops it', async () => {
    const name = `Cached ${uniq()}`;
    const before = await menu();
    await prisma.productType.create({ data: { name, slug: `cached-${uniq()}` } });   // a write that bypasses the admin API…
    expect(await menu()).toEqual(before);                                            // …is not seen while cached
    const created = await adminCall('post', '/product-types', { name: `Via admin ${uniq()}` });
    expect(created.status).toBe(201);
    expect(await menu()).toEqual(expect.arrayContaining([name, created.body.name]));

    const renamed = `Renamed ${uniq()}`;
    expect((await adminCall('patch', `/product-types/${created.body.id}`, { name: renamed })).status).toBe(200);
    expect(await menu()).toContain(renamed);

    const cat = await adminCall('post', '/categories', { typeId: created.body.id, name: `Cat ${uniq()}` });
    const withCat = (await request(app).get('/v1/navigation')).body.types.find((t: { id: number }) => t.id === created.body.id);
    expect(withCat.categories.map((c: { name: string }) => c.name)).toEqual([cat.body.name]);

    const ids = (await prisma.productType.findMany({ orderBy: { id: 'desc' }, select: { id: true } })).map((t) => t.id);
    expect((await adminCall('patch', '/product-types/reorder', { ids })).status).toBe(200);
    const top = (await prisma.productType.findMany({ where: { id: { in: ids }, isActive: true, showInMenu: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }))[0]!;
    expect((await menu())[0]).toBe(top.name);   // the newest type (moved to the top) leads the menu at once

    expect((await adminCall('delete', `/categories/${cat.body.id}`)).status).toBe(204);
    expect((await adminCall('delete', `/product-types/${created.body.id}`)).status).toBe(204);
    expect(await menu()).not.toContain(renamed);
  });

  it('a refused admin write (409 in use) leaves the cache alone; entries expire after 300 s', async () => {
    const t = await prisma.productType.create({ data: { name: `InUse ${uniq()}`, slug: `inuse-${uniq()}` } });
    await prisma.category.create({ data: { typeId: t.id, name: 'Keeps it in use', slug: `keep-${uniq()}` } });
    await adminCall('post', '/product-types', { name: `Bump ${uniq()}` });           // drop the cache so t is listed
    await menu();
    const gen = await redis.get('cache:gen:navigation');
    expect((await adminCall('delete', `/product-types/${t.id}`)).status).toBe(409);
    expect(await redis.get('cache:gen:navigation')).toBe(gen);
    const ttl = await redis.ttl(`cache:navigation:${gen}`);
    expect(ttl).toBeGreaterThan(APP_CACHE_TTL_S - 10);
    expect(ttl).toBeLessThanOrEqual(APP_CACHE_TTL_S);
  });

  it('a change that commits while a reader is loading is not stored over the new data', async () => {
    await appCache.invalidate('publicSettings');
    let v = 1;
    const load = async () => { const value = v; await appCache.invalidate('publicSettings'); v = 2; return value; };   // a write lands mid-read
    expect(await appCache.get('publicSettings', load)).toBe(1);
    expect(await appCache.get('publicSettings', async () => v)).toBe(2);              // the old value went to a dead generation
    await appCache.invalidate('publicSettings');                                       // leave real settings for other tests
  });

  it('Redis down: answers come from PostgreSQL and the problem is reported; invalidation does not fail the admin write', async () => {
    const dead = new Redis({ port: 1, lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null });
    dead.on('error', () => {});   // expected: nothing listens on port 1
    const errors: string[] = [];
    const broken = new RedisAppCache(dead, (op) => errors.push(op));
    const t = await prisma.productType.create({ data: { name: `NoRedis ${uniq()}`, slug: `noredis-${uniq()}` } });
    const solo = createApp({ version: 't', origins: { storefront: [WEB], admin: [ADMIN_ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} }, routes: [storefrontRouter({ mediaUrl: CDN, prisma, cache: broken })] });
    const res = await request(solo).get('/v1/navigation');
    expect(res.status).toBe(200);
    expect(res.body.types.map((x: { id: number }) => x.id)).toContain(t.id);
    await broken.invalidate('navigation');
    expect(errors).toEqual(expect.arrayContaining(['get', 'invalidate']));
    dead.disconnect();
  });

  it('a catalogue import that creates a type drops the cached menu (worker hook)', async () => {
    await menu();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('2. Products & Variants');
    const typeName = `Imported Type ${uniq()}`;
    ws.addRow(['Category (Type) *', 'Subcategory *', 'Product Name *', 'Size / Volume *', 'Selling Price (₹) *', 'Stock Quantity *', 'SKU']);
    ws.addRow([typeName, 'Imported Cat', `Imported ${uniq()}`, '1 kg', 100, 1, `IMP-${uniq()}`.toUpperCase()]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const imports = new ImportService({ prisma, readFile: async () => buffer, enqueue: { validate: async () => {}, apply: async () => {} }, onCatalogChanged: () => appCache.invalidate('navigation') });
    const [m] = await prisma.$queryRaw<{ id: number }[]>`INSERT INTO media (key, visibility, kind, declared_mime, declared_size, owner_scope, status, uploaded_by, updated_at)
      VALUES (${`private/catalog-import/${uniq()}.xlsx`}, 'PRIVATE', 'DOCUMENT', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ${buffer.length}, 'import', 'READY', ${adminId}, now()) RETURNING id`;
    const actor = { userId: adminId, role: 'SUPER_ADMIN' as const };
    const imp = await imports.create({ kind: 'CATALOG', fileMediaId: m!.id, createMissing: true }, actor);
    expect(await imports.validate(imp.id, true)).toBe('VALIDATED');
    await imports.confirm(imp.id, actor);
    expect(await imports.apply(imp.id)).toBe('DONE');
    expect(await menu()).toContain(typeName);
  });
});
