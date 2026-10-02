// Task 2.6: product types / categories / techniques CRUD on real PostgreSQL + Redis.
// ✅ Delete in use → 409 with guidance.
import type { PrismaClient, UserRole } from '@prisma/client';
import type { Express } from 'express';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdminRouter } from '../../src/admin/router.js';
import { createApp } from '../../src/app.js';
import { adminAuthRouter } from '../../src/auth/admin-routes.js';
import { AuthService, DEFAULT_AUTH_TIMINGS } from '../../src/auth/service.js';
import { RedisSessionCache } from '../../src/auth/session-cache.js';
import { registerCatalogRoutes } from '../../src/catalog/routes.js';
import { CatalogService } from '../../src/catalog/service.js';
import { registerTaxonomyRoutes } from '../../src/catalog/taxonomy-routes.js';
import * as fn from '../../src/db/functions.js';
import { hashPassword } from '../../src/lib/password.js';
import type { RateLimiter } from '../../src/middleware/rateLimit.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { uniq, val } from '../helpers/fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const ADMIN_ORIGIN = 'http://localhost:5173';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const PASSWORD = 'catalog-password-123';
const NO_LIMIT: RateLimiter = { hit: async () => ({ count: 0, resetMs: 60_000 }) };

let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express;
const missingAudit: string[] = [];
let ADMIN: { id: number; token: string }, STAFF: { token: string };

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  const cache = new RedisSessionCache(redis);
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: 'http://localhost:3000', adminUrl: ADMIN_ORIGIN });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log: pino({ level: 'silent' }), hasRecentStepUp: (sid) => service.hasRecentStepUp(sid), onMissingAudit: (req) => missingAudit.push(`${req.method} ${req.originalUrl}`) });
  registerCatalogRoutes(admin, new CatalogService(prisma));
  registerTaxonomyRoutes(admin, prisma, (m) => ({ renditions: Object.fromEntries(Object.entries(m.renditions as Record<string, string>).map(([w, k]) => [w, `https://cdn.test/${k}`])) }));
  app = createApp({
    version: 't', origins: { storefront: ['http://localhost:3000'], admin: [ADMIN_ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }), admin.router],
  });
  [ADMIN, STAFF] = [await login('ADMIN'), await login('STAFF')];
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });

async function login(role: UserRole) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  const u = await prisma.user.create({ data: { email, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword(PASSWORD) } });
  const res = await request(app).post('/v1/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email, password: PASSWORD });
  return { id: u.id, token: res.body.accessToken as string };
}
type Method = 'get' | 'post' | 'patch' | 'delete';
const call = (method: Method, path: string, who: { token: string } | null = ADMIN, body?: object) => {
  let r = request(app)[method](`/v1/admin${path}`).set('Origin', ADMIN_ORIGIN);
  if (who) r = r.set('Authorization', `Bearer ${who.token}`);
  return body ? r.send(body) : r;
};
const ok = async (method: Method, path: string, body?: object, status = 200) => {
  const res = await call(method, path, ADMIN, body);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
};
const type = (name = `Type ${uniq()}`, extra: object = {}) => ok('post', '/product-types', { name, ...extra }, 201) as Promise<{ id: number; slug: string; name: string }>;
const category = (typeId: number, name = `Cat ${uniq()}`, extra: object = {}) => ok('post', '/categories', { typeId, name, ...extra }, 201) as Promise<{ id: number; slug: string }>;
const technique = (name = `Tech ${uniq()}`) => ok('post', '/techniques', { name }, 201) as Promise<{ id: number; slug: string }>;
const product = (body: object) => ok('post', '/products', { name: `Product ${uniq()}`, ...body }, 201) as Promise<{ id: number }>;
async function media(status = 'READY') {
  return val<number>(prisma, `INSERT INTO media (key, visibility, kind, declared_mime, declared_size, owner_scope, status, renditions, updated_at)
    VALUES ($1,'PUBLIC','IMAGE','image/webp',10,'admin',$2::"MediaStatus",'{"160":"t/160.webp"}',now()) RETURNING id`, `k-${uniq()}`, status);
}
const redirect = (entity: string, oldSlug: string) => prisma.slugRedirect.findUnique({ where: { entity_oldSlug: { entity, oldSlug } } });

describe('✅ delete in use → 409 with guidance; nothing is deleted', () => {
  it('a type used by products and categories', async () => {
    const t = await type('Resin Kits');
    const c = await category(t.id, 'Starter');
    await product({ categoryId: c.id });
    await product({ typeId: t.id });
    const res = await call('delete', `/product-types/${t.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'TAXONOMY_IN_USE', details: { products: 2, categories: 1 },
      message: '“Resin Kits” is used by 2 products and 1 category. Move them to another type (or archive the products) first, or turn the type off to hide it.',
    });
    expect(await prisma.productType.count({ where: { id: t.id } })).toBe(1);
  });

  it('a type with only categories; a category used by an archived product; a technique on a product', async () => {
    const t = await type();
    const c = await category(t.id, 'Moulds');
    let res = await call('delete', `/product-types/${t.id}`);
    expect([res.status, res.body.error.details]).toEqual([409, { products: 0, categories: 1 }]);
    const p = await product({ categoryId: c.id });
    await prisma.product.update({ where: { id: p.id }, data: { status: 'ARCHIVED' } });   // history still points at it
    res = await call('delete', `/categories/${c.id}`);
    expect([res.status, res.body.error.message]).toEqual([409, '“Moulds” is used by 1 product. Move its products to another category (or archive them) first, or turn the category off to hide it.']);
    const tech = await technique('Deep Pour');
    await product({ techniqueIds: [tech.id] });
    res = await call('delete', `/techniques/${tech.id}`);
    expect([res.status, res.body.error.message]).toEqual([409, '“Deep Pour” is used by 1 product. Remove the technique from those products first, or turn it off to hide it.']);
    expect(await prisma.technique.count({ where: { id: tech.id } })).toBe(1);
  });

  it('unused records delete (204), audited; their redirects go too; unknown → 404', async () => {
    const t = await type('Glitter');
    await ok('patch', `/product-types/${t.id}`, { slug: 'glitter-sparkle' });
    expect(await redirect('type', 'glitter')).not.toBeNull();
    expect((await call('delete', `/product-types/${t.id}`)).status).toBe(204);
    expect(await redirect('type', 'glitter')).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'product_type.delete', entityId: String(t.id) } })).toBe(1);
    const tech = await technique();
    expect((await call('delete', `/techniques/${tech.id}`)).status).toBe(204);
    for (const p of ['/product-types', '/categories', '/techniques']) expect((await call('delete', `${p}/999999`)).status).toBe(404);
  });
});

describe('product types', () => {
  it('create: slug from the name (next free one when taken); full record; audited', async () => {
    const a = await type('Epoxy Resin & Hardener', { description: 'Two-part resins', showOnHome: false, tileLinkUrl: '/types/epoxy-resin-hardener', metaTitle: 'Epoxy' });
    expect(a).toMatchObject({ name: 'Epoxy Resin & Hardener', slug: 'epoxy-resin-hardener', showOnHome: false, showInMenu: true, isActive: true, tileLinkUrl: '/types/epoxy-resin-hardener', usage: { products: 0, categories: 0 } });
    expect((await type('Epoxy Resin & Hardener')).slug).toBe('epoxy-resin-hardener-2');
    expect(await prisma.auditLog.count({ where: { action: 'product_type.create', entityId: String(a.id) } })).toBe(1);
  });

  it.each([
    ['no name', {}], ['empty name', { name: ' ' }], ['81-character name', { name: 'n'.repeat(81) }],
    ['bad slug', { name: 'X', slug: 'Epoxy Resin' }], ['a tile link that is not a path or https', { name: 'X', tileLinkUrl: 'javascript:alert(1)' }],
    ['an http tile link', { name: 'X', tileLinkUrl: 'http://artq.in' }], ['an unknown field', { name: 'X', productCount: 3 }],
  ])('400 for %s', async (_l, body) => {
    expect((await call('post', '/product-types', ADMIN, body)).status).toBe(400);
  });

  it('boundary: an 80-character name is accepted', async () => {
    expect((await type('n'.repeat(80))).name).toHaveLength(80);
  });

  it('rename the slug: 301 chain stays flat; reclaiming an old slug drops its redirect; a slug in use → 409', async () => {
    const t = await type('Moulds');
    await ok('patch', `/product-types/${t.id}`, { slug: 'silicone-moulds' });
    await ok('patch', `/product-types/${t.id}`, { slug: 'resin-moulds' });
    expect((await redirect('type', 'moulds'))?.newSlug).toBe('resin-moulds');
    expect((await redirect('type', 'silicone-moulds'))?.newSlug).toBe('resin-moulds');
    await ok('patch', `/product-types/${t.id}`, { slug: 'moulds' });
    expect(await redirect('type', 'moulds')).toBeNull();
    const other = await type('Other Moulds');
    expect((await call('patch', `/product-types/${other.id}`, ADMIN, { slug: 'moulds' })).body.error.code).toBe('SLUG_TAKEN');
  });

  it('images must be usable product images', async () => {
    const t = await type();
    const good = await media();
    const res = await ok('patch', `/product-types/${t.id}`, { imageMediaId: good });
    expect(res.media[good]).toMatchObject({ renditions: { 160: 'https://cdn.test/t/160.webp' } });
    expect((await call('patch', `/product-types/${t.id}`, ADMIN, { bannerMediaId: await media('FAILED') })).body.error.code).toBe('MEDIA_NOT_USABLE');
    expect((await call('patch', `/product-types/${t.id}`, ADMIN, { imageMediaId: 999_999 })).body.error.code).toBe('MEDIA_NOT_USABLE');
  });

  it('empty update → 400; STAFF → 403 for every change but may read; no token → 401', async () => {
    const t = await type();
    expect((await call('patch', `/product-types/${t.id}`, ADMIN, {})).status).toBe(400);
    expect((await call('post', '/product-types', STAFF, { name: 'X' })).status).toBe(403);
    expect((await call('patch', `/product-types/${t.id}`, STAFF, { name: 'X' })).status).toBe(403);
    expect((await call('delete', `/product-types/${t.id}`, STAFF)).status).toBe(403);
    expect((await call('patch', '/product-types/reorder', STAFF, { ids: [t.id] })).status).toBe(403);
    expect((await call('get', `/product-types/${t.id}`, STAFF)).status).toBe(200);
    expect((await call('get', '/product-types', null)).status).toBe(401);
  });

  it('reorder sets the display order; unknown ids → 422; duplicates → 400', async () => {
    const [a, b, c] = [await type('Z First'), await type('Y Second'), await type('X Third')];
    await ok('patch', '/product-types/reorder', { ids: [c.id, a.id, b.id] });
    const order = (await ok('get', '/product-types')).data.map((t: { id: number }) => t.id).filter((id: number) => [a.id, b.id, c.id].includes(id));
    expect(order).toEqual([c.id, a.id, b.id]);
    expect((await call('patch', '/product-types/reorder', ADMIN, { ids: [a.id, 999_999] })).status).toBe(422);
    expect((await call('patch', '/product-types/reorder', ADMIN, { ids: [a.id, a.id] })).status).toBe(400);
    expect((await call('patch', '/product-types/reorder', ADMIN, { ids: [] })).status).toBe(400);
  });

  it('list with counts: products, categories, Unassigned and All', async () => {
    const t = await type('Counted');
    await category(t.id);
    await product({ typeId: t.id });
    const res = await ok('get', '/product-types?withCounts=1');
    expect(res.data.find((x: { id: number }) => x.id === t.id)).toMatchObject({ name: 'Counted', productCount: 1, categoryCount: 1, image: null, showOnHome: true });
    expect(res.total).toBe(await prisma.product.count({ where: { deletedAt: null } }));
  });

  it('renaming a type re-indexes its products for search', async () => {
    const t = await type('Pigments');
    const p = await product({ typeId: t.id });
    await ok('patch', `/product-types/${t.id}`, { name: 'Mica Powders' });
    await prisma.$transaction((tx) => fn.processSearchQueue(tx));
    expect(await val(prisma, `SELECT search_vector @@ plainto_tsquery('simple','mica') FROM products WHERE id = $1`, p.id)).toBe(true);
  });
});

describe('categories', () => {
  it('belong to a type; names unique within a type only; HSN/GST defaults validated with the boundaries', async () => {
    const [t1, t2] = [await type(), await type()];
    const c = await category(t1.id, 'Teak', { defaultHsnCode: '4414', defaultGstRate: 0 });
    expect(c).toMatchObject({ typeId: t1.id, defaultHsnCode: '4414', defaultGstRate: 0 });
    expect((await call('post', '/categories', ADMIN, { typeId: t1.id, name: 'Teak' })).body.error.code).toBe('NAME_TAKEN');
    expect((await category(t2.id, 'Teak')).slug).toBe('teak-2');
    expect((await category(t2.id, 'Gst Max', { defaultGstRate: 40 }))).toBeTruthy();
    for (const bad of [{ defaultGstRate: 40.01 }, { defaultGstRate: 18.255 }, { defaultHsnCode: '44141' }, {}].map((b, i) => (i === 3 ? { name: 'No type' } : { typeId: t1.id, name: `Bad ${i}`, ...b }))) {
      expect((await call('post', '/categories', ADMIN, bad)).status).toBe(400);
    }
    expect((await call('post', '/categories', ADMIN, { typeId: 999_999, name: 'Orphan' })).body.error.code).toBe('TAXONOMY_NOT_FOUND');
  });

  it('moving a category to another type: allowed while unused, refused while products use it', async () => {
    const [t1, t2] = [await type(), await type()];
    const c = await category(t1.id);
    expect((await ok('patch', `/categories/${c.id}`, { typeId: t2.id })).typeId).toBe(t2.id);
    await product({ categoryId: c.id });
    const res = await call('patch', `/categories/${c.id}`, ADMIN, { typeId: t1.id });
    expect([res.status, res.body.error.code]).toEqual([409, 'TAXONOMY_IN_USE']);
    expect((await prisma.category.findUniqueOrThrow({ where: { id: c.id } })).typeId).toBe(t2.id);
  });

  it('list by type with product counts', async () => {
    const t = await type();
    const [a, b] = [await category(t.id, 'A cat'), await category(t.id, 'B cat')];
    await product({ categoryId: b.id });
    await ok('patch', '/categories/reorder', { ids: [b.id, a.id] });
    const res = await ok('get', `/categories?typeId=${t.id}&withCounts=1`);
    expect(res.data.map((c: { name: string; productCount: number }) => [c.name, c.productCount])).toEqual([['B cat', 1], ['A cat', 0]]);
  });
});

describe('techniques', () => {
  it('CRUD with counts', async () => {
    const tech = await technique('Flower Preservation');
    expect(tech.slug).toBe('flower-preservation');
    await product({ techniqueIds: [tech.id] });
    expect((await ok('patch', `/techniques/${tech.id}`, { isActive: false, heroMediaId: await media() })).isActive).toBe(false);
    expect((await ok('get', '/techniques?withCounts=1')).data.find((t: { id: number }) => t.id === tech.id)).toMatchObject({ productCount: 1, isActive: false });
    expect((await call('post', '/techniques', ADMIN, { name: 'x', heroMediaId: 'abc' })).status).toBe(400);
  });

  it('every successful change recorded an audit entry', () => { expect(missingAudit).toEqual([]); });
});
