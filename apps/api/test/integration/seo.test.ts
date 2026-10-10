// Task 6.4 on real PostgreSQL + Redis: SEO. The public resolve (a redirect followed up to 3 hops, a temporary hop keeps
// the move temporary, a loop counts as none; overrides; addresses normalised; publicly cacheable) and the sitemap
// entries (only what a visitor can open, the cover image, noindex paths listed). Admin: redirects (reserved shop
// addresses refused, never to itself, never onto an address that already redirects, one per address, edit and
// delete, audited) and overrides (at least one field, one per address, audited); STAFF 403; 404s.
import type { PrismaClient, UserRole } from '@prisma/client';
import type { Express } from 'express';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdminRouter } from '../../src/admin/router.js';
import { createApp } from '../../src/app.js';
import { adminAuthRouter } from '../../src/auth/admin-routes.js';
import { AuthService, DEFAULT_AUTH_TIMINGS } from '../../src/auth/service.js';
import { RedisSessionCache } from '../../src/auth/session-cache.js';
import { hashPassword } from '../../src/lib/password.js';
import { registerSeoAdminRoutes, seoRouter } from '../../src/seo/routes.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { uniq } from '../helpers/fixtures.js';
import { liveProduct } from '../helpers/storefront-fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const WEB = 'http://localhost:3000';
const ORIGIN = 'http://localhost:5173';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const log = pino({ level: 'silent' });
const NO_LIMIT = { hit: async () => ({ count: 0, resetMs: 60_000 }) };
let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express, ADMIN: { token: string }, STAFF: { token: string };
const missingAudit: string[] = [];

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  const cache = new RedisSessionCache(redis);
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: WEB, adminUrl: ORIGIN });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log, hasRecentStepUp: async () => true, onMissingAudit: (req) => missingAudit.push(`${req.method} ${req.originalUrl}`) });
  registerSeoAdminRoutes(admin, prisma);
  app = createApp({ version: 't', origins: { storefront: [WEB], admin: [ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }), seoRouter({ prisma, mediaUrl: (k) => `https://cdn.test/${k}` }), admin.router] });
  [ADMIN, STAFF] = await Promise.all([staff('ADMIN'), staff('STAFF')]);
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });
beforeEach(() => { missingAudit.length = 0; });

async function staff(role: UserRole) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  await prisma.user.create({ data: { email, name: role, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword('seo-password-1') } });
  return { token: (await request(app).post('/v1/admin/auth/login').set('Origin', ORIGIN).send({ email, password: 'seo-password-1' })).body.accessToken as string };
}
const admin = (method: 'get' | 'post' | 'put' | 'delete', path: string, who = ADMIN) => request(app)[method](`/v1/admin${path}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${who.token}`);
const resolve = (path: string) => request(app).get(`/v1/seo/resolve?path=${encodeURIComponent(path)}`);
const fieldOf = (res: request.Response) => (res.body.error.details as { path: string; message: string }[]).map((d) => [d.path, d.message]);

describe('public resolve', () => {
  it('a redirect, normalised and cacheable; chains followed to 3 hops; a temporary hop keeps it temporary; loops are none', async () => {
    const u = uniq();
    await prisma.redirect.createMany({ data: [
      { fromPath: `/old-${u}`, toPath: '/shop?type=resins' },
      { fromPath: `/a-${u}`, toPath: `/b-${u}` }, { fromPath: `/b-${u}`, toPath: `/c-${u}`, statusCode: 302 }, { fromPath: `/c-${u}`, toPath: '/faqs' },
      { fromPath: `/h1-${u}`, toPath: `/h2-${u}` }, { fromPath: `/h2-${u}`, toPath: `/h3-${u}` }, { fromPath: `/h3-${u}`, toPath: `/h4-${u}` }, { fromPath: `/h4-${u}`, toPath: '/end' },
      { fromPath: `/x-${u}`, toPath: `/y-${u}` }, { fromPath: `/y-${u}`, toPath: `/X-${u}` },
    ] });
    const res = await resolve(`/OLD-${u}/?utm=1`);
    expect(res.body).toEqual({ redirect: { to: '/shop?type=resins', status: 301 }, seo: null });
    expect(res.headers['cache-control']).toBe('public, max-age=0, s-maxage=60, stale-while-revalidate=60');
    expect((await resolve(`/a-${u}`)).body.redirect).toEqual({ to: '/faqs', status: 302 });
    expect((await resolve(`/h1-${u}`)).body.redirect).toEqual({ to: `/h4-${u}`, status: 301 });   // stops after 3 hops
    expect((await resolve(`/x-${u}`)).body.redirect).toBeNull();
    expect((await resolve('/nothing-here')).body).toEqual({ redirect: null, seo: null });
    expect((await request(app).get('/v1/seo/resolve?path=no-slash')).status).toBe(400);
    expect((await request(app).get('/v1/seo/resolve')).status).toBe(400);
  });

  it('an override is returned for its address', async () => {
    await prisma.seoOverride.create({ data: { path: '/new-arrivals', metaTitle: 'Fresh resin supplies', noindex: false } });
    expect((await resolve('/New-Arrivals')).body.seo).toEqual({ metaTitle: 'Fresh resin supplies', metaDescription: null, canonical: null, noindex: false });
  });

  it('sitemap entries: live products (with cover), active taxonomy, published pages; noindex paths', async () => {
    const live = await liveProduct(prisma);
    const draft = await liveProduct(prisma, { status: 'DRAFT' });
    const noPrice = await liveProduct(prisma);
    await prisma.productVariant.updateMany({ where: { productId: noPrice.productId }, data: { isActive: false } });
    const offType = await prisma.productType.create({ data: { name: `Off ${uniq()}`, slug: `off-${uniq()}`, isActive: false } });
    await prisma.cmsPage.create({ data: { slug: `hidden-${uniq()}`, title: 'Hidden', content: '<p>x</p>', isPublished: false } });
    const shown = await prisma.cmsPage.create({ data: { slug: `shown-${uniq()}`, title: 'Shown', content: '<p>x</p>' } });
    await prisma.seoOverride.create({ data: { path: `/${shown.slug}`, noindex: true } });
    const res = await request(app).get('/v1/seo/sitemap-entries');
    expect(res.headers['cache-control']).toMatch(/^public/);
    const slugs = (res.body.products as { slug: string }[]).map((p) => p.slug);
    expect(slugs).toContain(live.slug);
    expect(slugs).not.toContain(draft.slug);
    expect(slugs).not.toContain(noPrice.slug);
    expect(res.body.products.find((p: { slug: string }) => p.slug === live.slug)).toEqual({ slug: live.slug, updatedAt: expect.stringMatching(/^\d{4}-/), image: expect.stringMatching(/^https:\/\/cdn\.test\//) });
    expect((res.body.types as { slug: string }[]).map((t) => t.slug)).not.toContain(offType.slug);
    expect((res.body.categories as { slug: string }[]).length).toBeGreaterThan(0);
    expect((res.body.pages as { slug: string }[]).map((p) => p.slug)).toContain(shown.slug);
    expect((res.body.pages as { slug: string }[]).map((p) => p.slug).some((s) => s.startsWith('hidden-'))).toBe(false);
    expect(res.body.noindex).toContain(`/${shown.slug}`);
  });
});

describe('admin redirects', () => {
  it('create (normalised), list and search, edit, delete; audited; STAFF 403', async () => {
    const u = uniq();
    const made = await admin('post', '/seo/redirects').send({ fromPath: `/Collections/Resin-${u}/`, toPath: '/type/resins' });
    expect(made.status).toBe(201);
    expect(made.body).toEqual({ id: expect.any(Number), fromPath: `/collections/resin-${u}`, toPath: '/type/resins', statusCode: 301 });
    expect((await admin('get', `/seo/redirects?q=resin-${u}`)).body).toMatchObject({ data: [made.body], meta: { total: 1 } });
    const edited = await admin('put', `/seo/redirects/${made.body.id}`).send({ fromPath: `/collections/resin-${u}`, toPath: '/shop', statusCode: 302 });
    expect(edited.body).toMatchObject({ toPath: '/shop', statusCode: 302 });
    expect((await admin('delete', `/seo/redirects/${made.body.id}`)).status).toBe(204);
    expect((await admin('delete', `/seo/redirects/${made.body.id}`)).status).toBe(404);
    expect((await admin('put', '/seo/redirects/999999').send({ fromPath: '/q', toPath: '/shop' })).status).toBe(404);
    expect(await prisma.auditLog.count({ where: { entity: 'redirect', entityId: String(made.body.id) } })).toBe(3);
    expect(missingAudit).toEqual([]);
    expect((await admin('get', '/seo/redirects', STAFF)).status).toBe(403);
    expect((await admin('post', '/seo/redirects', STAFF).send({ fromPath: '/z', toPath: '/shop' })).status).toBe(403);
  });

  it('refused: shop addresses, itself, another site, a redirect onto one that already redirects, a second one for the same address', async () => {
    const u = uniq();
    for (const [body, field] of [
      [{ fromPath: '/product/old-thing', toPath: '/shop' }, 'fromPath'],
      [{ fromPath: '/', toPath: '/shop' }, 'fromPath'],
      [{ fromPath: '/checkout/x', toPath: '/shop' }, 'fromPath'],
      [{ fromPath: `/same-${u}`, toPath: `/Same-${u}/` }, 'toPath'],
      [{ fromPath: `/ext-${u}`, toPath: '//evil.example' }, 'toPath'],
      [{ fromPath: `/ext-${u}`, toPath: 'https://evil.example' }, 'toPath'],
      [{ fromPath: 'no-slash', toPath: '/shop' }, 'fromPath'],
      [{ fromPath: `/q-${u}?x=1`, toPath: '/shop' }, 'fromPath'],
      [{ fromPath: `/s-${u}`, toPath: '/shop', statusCode: 307 }, 'statusCode'],
    ] as const) {
      const res = await admin('post', '/seo/redirects').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(fieldOf(res).map(([p]) => p)).toContain(field);
    }
    await admin('post', '/seo/redirects').send({ fromPath: `/first-${u}`, toPath: '/faqs' });
    const chain = await admin('post', '/seo/redirects').send({ fromPath: `/zero-${u}`, toPath: `/first-${u}` });
    expect(fieldOf(chain)).toEqual([['toPath', 'That address already redirects to /faqs. Point straight there.']]);
    const dup = await admin('post', '/seo/redirects').send({ fromPath: `/FIRST-${u}`, toPath: '/contact' });
    expect(fieldOf(dup)).toEqual([['fromPath', 'This address already has a redirect']]);
    expect((await admin('post', '/seo/redirects').send({ fromPath: '/x'.repeat(150) + 'x', toPath: '/shop' })).status).toBe(400);   // 301 characters
    expect((await admin('post', '/seo/redirects').send({ fromPath: `/${'x'.repeat(299)}`, toPath: '/shop' })).status).toBe(201);   // exactly 300
  });

  it('two saves of the same address at once: one wins, the other is told on the field', async () => {
    const u = uniq();
    const both = await Promise.all([1, 2].map(() => admin('post', '/seo/redirects').send({ fromPath: `/race-${u}`, toPath: '/shop' })));
    expect(both.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(await prisma.redirect.count({ where: { fromPath: `/race-${u}` } })).toBe(1);
  });
});

describe('admin overrides', () => {
  it('create, edit, delete with audit; at least one field; one per address; limits at the boundary', async () => {
    const u = uniq();
    expect(fieldOf(await admin('post', '/seo/overrides').send({ path: `/p-${u}` }))).toEqual([['metaTitle', 'Set at least one of title, description, canonical or “hide from search”']]);
    const made = await admin('post', '/seo/overrides').send({ path: `/P-${u}`, metaTitle: 't'.repeat(160), metaDescription: 'd'.repeat(320), canonical: '/shop' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ path: `/p-${u}`, noindex: false, canonical: '/shop' });
    expect(fieldOf(await admin('post', '/seo/overrides').send({ path: `/p-${u}`, noindex: true }))).toEqual([['path', 'This address already has an override; edit that one']]);
    expect((await admin('post', '/seo/overrides').send({ path: `/t-${u}`, metaTitle: 't'.repeat(161) })).status).toBe(400);
    expect((await admin('post', '/seo/overrides').send({ path: `/t-${u}`, metaDescription: 'd'.repeat(321) })).status).toBe(400);
    expect((await admin('post', '/seo/overrides').send({ path: `/t-${u}`, canonical: 'http://insecure.example/x' })).status).toBe(400);
    expect((await admin('post', '/seo/overrides').send({ path: `/t-${u}`, canonical: 'https://artq.in/shop' })).status).toBe(201);
    const edited = await admin('put', `/seo/overrides/${made.body.id}`).send({ path: `/p-${u}`, noindex: true });
    expect(edited.body).toEqual({ id: made.body.id, path: `/p-${u}`, metaTitle: null, metaDescription: null, canonical: null, noindex: true });
    expect((await admin('get', `/seo/overrides?q=p-${u}`)).body.data).toEqual([edited.body]);
    expect((await admin('delete', `/seo/overrides/${made.body.id}`)).status).toBe(204);
    expect((await admin('delete', `/seo/overrides/${made.body.id}`)).status).toBe(404);
    expect(await prisma.auditLog.count({ where: { entity: 'seo_override', entityId: String(made.body.id) } })).toBe(3);
    expect(missingAudit).toEqual([]);
    expect((await admin('get', '/seo/overrides', STAFF)).status).toBe(403);
  });
});
