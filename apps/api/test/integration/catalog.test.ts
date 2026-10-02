// Task 2.2: catalogue services through the real /v1/admin routes, on real PostgreSQL + Redis.
// ✅ Variant price change updates min_price in the same transaction; product_aggregate_drift empty after 1,000 random edits;
// AT-10 re-run against the real variant, pricing and bulk endpoints.
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
import { catalogConstraintError } from '../../src/catalog/errors.js';
import { registerCatalogRoutes } from '../../src/catalog/routes.js';
import { CatalogService } from '../../src/catalog/service.js';
import * as fn from '../../src/db/functions.js';
import { hashPassword } from '../../src/lib/password.js';
import type { RateLimiter } from '../../src/middleware/rateLimit.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { order, uniq, val } from '../helpers/fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const ADMIN_ORIGIN = 'http://localhost:5173';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const PASSWORD = 'catalog-password-123';
const NO_LIMIT: RateLimiter = { hit: async () => ({ count: 0, resetMs: 60_000 }) };

let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express, catalog: CatalogService;
const missingAudit: string[] = [];
let ADMIN: { id: number; token: string }, STAFF: { id: number; token: string };
let typeA: number, typeB: number, catA1: number, catA2: number, catB1: number, tech1: number, tech2: number;

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  const cache = new RedisSessionCache(redis);
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: 'http://localhost:3000', adminUrl: 'http://localhost:5173' });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log: pino({ level: 'silent' }), hasRecentStepUp: (sid) => service.hasRecentStepUp(sid), onMissingAudit: (req) => missingAudit.push(`${req.method} ${req.originalUrl}`) });
  catalog = new CatalogService(prisma);
  registerCatalogRoutes(admin, catalog);
  app = createApp({
    version: 't', origins: { storefront: ['http://localhost:3000'], admin: [ADMIN_ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }), admin.router],
  });
  [ADMIN, STAFF] = [await login('ADMIN'), await login('STAFF')];
  const u = uniq();
  typeA = await val<number>(prisma, `INSERT INTO product_types (name, slug, updated_at) VALUES ('Resin','resin-${u}',now()) RETURNING id`);
  typeB = await val<number>(prisma, `INSERT INTO product_types (name, slug, updated_at) VALUES ('Frames','frames-${u}',now()) RETURNING id`);
  const cat = (t: number, n: string) => val<number>(prisma, `INSERT INTO categories (type_id, name, slug, updated_at) VALUES ($1,$2,$3,now()) RETURNING id`, t, n, `${n.toLowerCase()}-${u}`);
  [catA1, catA2, catB1] = [await cat(typeA, 'Epoxy'), await cat(typeA, 'Pigments'), await cat(typeB, 'Teak')];
  const tech = (n: string) => val<number>(prisma, `INSERT INTO techniques (name, slug, updated_at) VALUES ($1,$2,now()) RETURNING id`, n, `${n}-${u}`);
  [tech1, tech2] = [await tech('pour'), await tech('mould')];
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });

async function login(role: UserRole) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  const u = await prisma.user.create({ data: { email, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword(PASSWORD) } });
  const res = await request(app).post('/v1/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { id: u.id, token: res.body.accessToken as string };
}
type Method = 'get' | 'post' | 'patch' | 'delete';
const call = (method: Method, path: string, who: { token: string } | null = ADMIN, body?: object) => {
  let r = request(app)[method](`/v1/admin${path}`).set('Origin', ADMIN_ORIGIN);
  if (who) r = r.set('Authorization', `Bearer ${who.token}`);
  return body ? r.send(body) : r;
};
const create = async (body: object) => {
  const res = await call('post', '/products', ADMIN, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: number; slug: string; version: number; variants: { id: number; sku: string; version: number; price: number | null }[] };
};
const variant = (id: number) => prisma.productVariant.findUniqueOrThrow({ where: { id } });
const product = (id: number) => prisma.product.findUniqueOrThrow({ where: { id } });
const drift = () => val<bigint>(prisma, `SELECT count(*) FROM product_aggregate_drift`);
async function setPrice(id: number, p: number, mrp: number | null = null) {
  const v = await variant(id);
  const res = await call('patch', `/variants/${id}/pricing`, ADMIN, { price: p, mrp, version: v.version });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/** Makes a draft pass every product.md §8.7 gate check so it can be ACTIVE (as in doc-validation C12). */
async function makeActive(productId: number) {
  await prisma.$executeRawUnsafe(`UPDATE products SET hsn_code='3907', gst_rate=18, tax_approved_at=now(), description='d',
    type_id=coalesce(type_id, $2), category_id=coalesce(category_id, $3) WHERE id=$1`, productId, typeA, catA1);
  await prisma.$executeRawUnsafe(`UPDATE product_variants SET weight_g=350, weight_source='MEASURED', price=coalesce(price, 1000), net_quantity=1, net_unit='PCS' WHERE product_id=$1`, productId);
  const ids = (await prisma.productVariant.findMany({ where: { productId }, select: { id: true } })).map((v) => v.id);
  await prisma.$transaction((tx) => fn.adjustOnHand(tx, { rows: ids.map((variantId) => ({ variantId, kind: 'RECOUNT' as const, quantity: 3 })), actorId: null }));
  const media = await val<number>(prisma, `INSERT INTO media (key, visibility, kind, declared_mime, declared_size, owner_scope, status, updated_at)
    VALUES ($1,'PUBLIC','IMAGE','image/webp',10,'admin','READY',now()) RETURNING id`, `k-${uniq()}`);
  await prisma.$executeRawUnsafe(`INSERT INTO product_images (product_id, media_id, is_cover) VALUES ($1,$2,true)`, productId, media);
  await prisma.$executeRawUnsafe(`UPDATE products SET status='ACTIVE', is_publishable=true, published_at=now() WHERE id=$1`, productId);
}

describe('create product (POST /products)', () => {
  it('creates a DRAFT with a slug from the name, normalised sizes, generated SKUs, aggregates and an audit row', async () => {
    const p = await create({
      name: 'Epoxy Resin 2:1', categoryId: catA1, techniqueIds: [tech1, tech1, tech2],
      variants: [{ size: '500GM' }, { size: '1 kg', color: 'Clear', sku: 'er-1kg' }],
    });
    expect(p).toMatchObject({ status: 'DRAFT', slug: 'epoxy-resin-2-1', type: { id: typeA }, category: { id: catA1 }, techniqueIds: [tech1, tech2], version: 1 });
    expect(p.variants.map((v) => [v.sku, (v as unknown as { size: string }).size])).toEqual([[`P${p.id}-V1`, '500 gm'], ['ER-1KG', '1 kg']]);
    expect(p.variants[0]).toMatchObject({ netQuantity: 500, netUnit: 'G', label: '500 gm', price: null, available: 0 });
    expect((p as unknown as { aggregates: object }).aggregates).toEqual({ minPrice: null, maxPrice: null, maxMrp: null, available: 0, activeVariants: 2 });
    expect((p as unknown as { readiness: { failures: { code: string }[] } }).readiness.failures.map((f) => f.code)).toEqual(expect.arrayContaining(['no_tax', 'no_image', 'no_price_or_size', 'stock_uncounted']));
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'product.create', entityId: String(p.id) } });
    expect(audit.actorId).toBe(ADMIN.id);
    // a second product with the same name gets the next free slug
    expect((await create({ name: 'Epoxy Resin 2:1' })).slug).toBe('epoxy-resin-2-1-2');
    expect(await drift()).toBe(0n);
  });

  it('minimal create: only a name; no type or category (Unassigned); no variants', async () => {
    const p = await create({ name: 'Mystery Item' });
    expect(p).toMatchObject({ type: null, category: null, variants: [] });
  });

  it.each([
    ['missing name', {}],
    ['empty name', { name: '  ' }],
    ['price on the content endpoint', { name: 'X', price: 100 }],
    ['price inside a variant', { name: 'X', variants: [{ size: '1 kg', price: 100 }] }],
    ['stock inside a variant', { name: 'X', variants: [{ size: '1 kg', onHand: 5 }] }],
    ['import flags on create', { name: 'X', dataFlags: ['PRICE_MISSING'] }],
    ['bad slug', { name: 'X', slug: 'Not A Slug' }],
    ['bad colour hex', { name: 'X', variants: [{ colorHex: 'gold' }] }],
    ['dimension with two decimals', { name: 'X', variants: [{ lengthCm: 10.25, widthCm: 1, heightCm: 1 }] }],
    ['too many variants', { name: 'X', variants: Array.from({ length: 51 }, (_, i) => ({ size: `${i + 1} gm` })) }],
  ])('400 for %s; nothing is created', async (_label, body) => {
    const before = await prisma.product.count();
    const res = await call('post', '/products', ADMIN, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.product.count()).toBe(before);
  });

  it.each([
    ['category of another type', () => ({ name: 'X', typeId: typeB, categoryId: catA1 }), 422, 'CATEGORY_TYPE_MISMATCH'],
    ['unknown category', () => ({ name: 'X', categoryId: 999_999 }), 422, 'TAXONOMY_NOT_FOUND'],
    ['unknown type', () => ({ name: 'X', typeId: 999_999 }), 422, 'TAXONOMY_NOT_FOUND'],
    ['unknown technique', () => ({ name: 'X', techniqueIds: [999_999] }), 422, 'TAXONOMY_NOT_FOUND'],
    ['unknown variant image', () => ({ name: 'X', variants: [{ imageMediaId: 999_999 }] }), 422, 'MEDIA_NOT_FOUND'],
    ['size without a unit', () => ({ name: 'X', variants: [{ size: '10' }] }), 422, 'SIZE_INVALID'],
    ['net quantity without a unit', () => ({ name: 'X', variants: [{ netQuantity: 5 }] }), 422, 'SIZE_INVALID'],
    ['partial dimensions', () => ({ name: 'X', variants: [{ lengthCm: 10 }] }), 422, 'DIMENSIONS_INCOMPLETE'],
    ['duplicate variant options', () => ({ name: 'X', variants: [{ size: '1 kg' }, { size: '1kg' }] }), 409, 'VARIANT_OPTIONS_EXIST'],
    ['duplicate SKU in the request', () => ({ name: 'X', variants: [{ sku: 'DUP-1', size: '1 kg' }, { sku: 'dup-1', size: '2 kg' }] }), 409, 'SKU_EXISTS'],
  ])('%s → %i %s; the whole create rolls back', async (_label, body, status, code) => {
    const before = await prisma.product.count();
    const res = await call('post', '/products', ADMIN, body());
    expect([res.status, res.body.error?.code]).toEqual([status, code]);
    expect(await prisma.product.count()).toBe(before);
  });

  it('SKU and slug uniqueness across products → 409', async () => {
    const a = await create({ name: 'Unique A', slug: `unique-a-${uniq()}`, variants: [{ sku: `SKU-${uniq()}`.toUpperCase() }] });
    expect((await call('post', '/products', ADMIN, { name: 'B', slug: a.slug })).body.error.code).toBe('SLUG_TAKEN');
    expect((await call('post', '/products', ADMIN, { name: 'B', variants: [{ sku: a.variants[0]!.sku }] })).body.error.code).toBe('SKU_EXISTS');
  });

  it('unauthenticated → 401; STAFF (catalog:read only) → 403', async () => {
    expect((await call('post', '/products', null, { name: 'X' })).status).toBe(401);
    expect((await call('post', '/products', STAFF, { name: 'X' })).status).toBe(403);
  });
});

describe('read product (GET /products/:id)', () => {
  it('editor payload; cost price only for pricing:write holders; STAFF can read', async () => {
    const p = await create({ name: 'Cost Check', variants: [{ size: '1 kg' }] });
    await prisma.productVariant.update({ where: { id: p.variants[0]!.id }, data: { costPrice: 1234 } });
    const admin = await call('get', `/products/${p.id}`);
    const staff = await call('get', `/products/${p.id}`, STAFF);
    expect([admin.status, staff.status]).toEqual([200, 200]);
    expect(admin.body.variants[0].costPrice).toBe(1234);
    expect(staff.body.variants[0]).not.toHaveProperty('costPrice');
    expect(admin.headers['cache-control']).toBe('private, no-store');
  });

  it('404 for an unknown id; 400 for a non-numeric id', async () => {
    expect((await call('get', '/products/999999')).status).toBe(404);
    expect((await call('get', '/products/abc')).status).toBe(400);
  });
});

describe('update product (PATCH /products/:id)', () => {
  it('updates content, bumps the version, audits before/after', async () => {
    const p = await create({ name: 'Rename Me', categoryId: catA1 });
    const res = await call('patch', `/products/${p.id}`, ADMIN, { version: 1, name: 'Renamed', tags: ['resin'], isNewArrival: true, techniqueIds: [tech2] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Renamed', tags: ['resin'], isNewArrival: true, techniqueIds: [tech2], version: 2 });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'product.update', entityId: String(p.id) } });
    expect(audit.before).toMatchObject({ name: 'Rename Me', tags: [] });
    expect(audit.after).toMatchObject({ name: 'Renamed', techniqueIds: [tech2] });
    expect((await call('patch', `/products/${p.id}`, ADMIN, { version: 2, techniqueIds: [] })).body.techniqueIds).toEqual([]);
  });

  it('stale version → 409 VERSION_CONFLICT with the current data; nothing changes', async () => {
    const p = await create({ name: 'Conflict' });
    await call('patch', `/products/${p.id}`, ADMIN, { version: 1, name: 'First' });
    const res = await call('patch', `/products/${p.id}`, ADMIN, { version: 1, name: 'Second' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { current: { name: 'First', version: 2 } } });
    expect((await product(p.id)).name).toBe('First');
  });

  it('two concurrent updates with the same version: exactly one wins', async () => {
    const p = await create({ name: 'Race' });
    const r = await Promise.all(['A', 'B', 'C', 'D'].map((n) => call('patch', `/products/${p.id}`, ADMIN, { version: 1, name: n })));
    expect(r.map((x) => x.status).sort()).toEqual([200, 409, 409, 409]);
    expect((await product(p.id)).version).toBe(2);
  });

  it('taxonomy: a category implies its type; a type alone must fit the current category; both may be cleared on a draft', async () => {
    const p = await create({ name: 'Taxonomy', categoryId: catA1 });
    let res = await call('patch', `/products/${p.id}`, ADMIN, { version: 1, categoryId: catB1 });
    expect(res.body).toMatchObject({ type: { id: typeB }, category: { id: catB1 } });
    res = await call('patch', `/products/${p.id}`, ADMIN, { version: 2, typeId: typeA });
    expect([res.status, res.body.error.code]).toEqual([422, 'CATEGORY_TYPE_MISMATCH']);
    res = await call('patch', `/products/${p.id}`, ADMIN, { version: 2, typeId: typeA, categoryId: catA2 });
    expect(res.body).toMatchObject({ type: { id: typeA }, category: { id: catA2 } });
    res = await call('patch', `/products/${p.id}`, ADMIN, { version: 3, typeId: null, categoryId: null });
    expect(res.body).toMatchObject({ type: null, category: null });
    res = await call('patch', `/products/${p.id}`, ADMIN, { version: 4, typeId: null, categoryId: catA1 });
    expect(res.body.error.code).toBe('CATEGORY_TYPE_MISMATCH');
  });

  it('data flags can be resolved (removed) but not added', async () => {
    const p = await create({ name: 'Flags' });
    await prisma.product.update({ where: { id: p.id }, data: { dataFlags: ['PRICE_MISSING', 'SIZE_CONFLICT'] } });
    const add = await call('patch', `/products/${p.id}`, ADMIN, { version: 1, dataFlags: ['PRICE_MISSING', 'MADE_UP'] });
    expect([add.status, add.body.error.code, add.body.error.details]).toEqual([422, 'FLAGS_ADD_FORBIDDEN', { flags: ['MADE_UP'] }]);
    expect((await call('patch', `/products/${p.id}`, ADMIN, { version: 1, dataFlags: ['SIZE_CONFLICT'] })).body.dataFlags).toEqual(['SIZE_CONFLICT']);
  });

  it.each([
    ['only a version', { version: 1 }],
    ['no version', { name: 'x' }],
    ['a price', { version: 1, price: 1 }],
    ['an aggregate', { version: 1, minPrice: 1 }],
    ['the status (publication is task 2.3)', { version: 1, status: 'ACTIVE' }],
    ['tax fields (tax approval endpoint)', { version: 1, hsnCode: '3907' }],
  ])('400 for %s', async (_l, body) => {
    const p = await create({ name: 'Bad Patch' });
    expect((await call('patch', `/products/${p.id}`, ADMIN, body)).status).toBe(400);
  });

  it('404 for an unknown product', async () => {
    expect((await call('patch', '/products/999999', ADMIN, { version: 1, name: 'x' })).status).toBe(404);
  });
});

describe('slug redirects', () => {
  it('renames keep 301 targets without chains; reclaiming an old slug drops its redirect', async () => {
    const s = `slug-${uniq()}`;
    const p = await create({ name: 'Slugged', slug: `${s}-a` });
    await call('patch', `/products/${p.id}`, ADMIN, { version: 1, slug: `${s}-b` });
    expect(await catalog.resolveProductSlug(`${s}-a`)).toEqual({ redirectTo: `${s}-b` });
    await call('patch', `/products/${p.id}`, ADMIN, { version: 2, slug: `${s}-c` });
    expect(await catalog.resolveProductSlug(`${s}-a`)).toEqual({ redirectTo: `${s}-c` });   // re-pointed, not a→b→c
    expect(await catalog.resolveProductSlug(`${s}-b`)).toEqual({ redirectTo: `${s}-c` });
    expect(await catalog.resolveProductSlug(`${s}-c`)).toEqual({ productId: p.id });
    // back to the first slug: its redirect is removed (no loop), the others now point at it
    await call('patch', `/products/${p.id}`, ADMIN, { version: 3, slug: `${s}-a` });
    expect(await catalog.resolveProductSlug(`${s}-a`)).toEqual({ productId: p.id });
    expect(await catalog.resolveProductSlug(`${s}-b`)).toEqual({ redirectTo: `${s}-a` });
    expect(await catalog.resolveProductSlug(`${s}-c`)).toEqual({ redirectTo: `${s}-a` });
    // a new product may take an old slug: the redirect goes, the new product wins
    const q = await create({ name: 'Taker', slug: `${s}-b` });
    expect(await catalog.resolveProductSlug(`${s}-b`)).toEqual({ productId: q.id });
    expect(await catalog.resolveProductSlug(`${s}-zzz`)).toBeNull();
  });

  it('renaming to a slug in use → 409 SLUG_TAKEN; no redirect is written', async () => {
    const a = await create({ name: 'Taken One' });
    const b = await create({ name: 'Taken Two' });
    const res = await call('patch', `/products/${b.id}`, ADMIN, { version: 1, slug: a.slug });
    expect([res.status, res.body.error.code]).toEqual([409, 'SLUG_TAKEN']);
    expect(await catalog.resolveProductSlug(b.slug)).toEqual({ productId: b.id });
  });
});

describe('variants (POST /products/:id/variants, PATCH /variants/:id)', () => {
  it('adds a variant (aggregates refreshed), edits it with a version, audits both', async () => {
    const p = await create({ name: 'Variant Host', variants: [{ size: '1 kg' }] });
    const add = await call('post', `/products/${p.id}/variants`, ADMIN, { size: '2 kg', color: 'Gold', colorHex: '#D4AF37', weightG: 2100, weightSource: 'MEASURED' });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ sku: `P${p.id}-V2`, label: '2 kg / Gold', netQuantity: 2, netUnit: 'KG', version: 1 });
    expect((await product(p.id)).activeVariantCount).toBe(2);
    const edit = await call('patch', `/variants/${add.body.id}`, ADMIN, { version: 1, isActive: false, label: 'Gold 2 kg', lengthCm: 30, widthCm: 20, heightCm: 10.5 });
    expect(edit.body).toMatchObject({ isActive: false, label: 'Gold 2 kg', heightCm: 10.5, version: 2 });
    expect((await product(p.id)).activeVariantCount).toBe(1);
    expect(await prisma.auditLog.count({ where: { entity: 'variant', entityId: String(add.body.id), action: { in: ['variant.create', 'variant.update'] } } })).toBe(2);
    expect(await drift()).toBe(0n);
  });

  it('size edits re-normalise; clearing the unit alone is refused', async () => {
    const p = await create({ name: 'Size Edit', variants: [{ size: '500 gm' }] });
    const v = p.variants[0]!;
    expect((await call('patch', `/variants/${v.id}`, ADMIN, { version: 1, size: '4X6' })).body).toMatchObject({ size: '4×6 in', netQuantity: 1, netUnit: 'PCS' })   // a frame is one piece; its size is the dimensions;
    const res = await call('patch', `/variants/${v.id}`, ADMIN, { version: 2, netUnit: null });
    expect([res.status, res.body.error.code]).toEqual([422, 'SIZE_INVALID']);
  });

  it.each([
    ['price', { price: 1 }], ['mrp', { mrp: 1 }], ['costPrice', { costPrice: 1 }], ['onHand', { onHand: 99 }], ['reserved', { reserved: 0 }],
    ['productId', { productId: 1 }], ['nothing to update', {}], ['negative weight', { weightG: -1 }],
  ])('PATCH variant with %s → 400', async (_l, extra) => {
    const p = await create({ name: 'Variant 400', variants: [{ size: '1 kg' }] });
    expect((await call('patch', `/variants/${p.variants[0]!.id}`, ADMIN, { version: 1, ...extra })).status).toBe(400);
  });

  it('stale variant version → 409 with the current variant; unknown or deleted variant → 404; unknown product → 404', async () => {
    const p = await create({ name: 'Variant 409', variants: [{ size: '1 kg' }, { size: '2 kg' }] });
    const [v1, v2] = p.variants as [{ id: number }, { id: number }];
    await call('patch', `/variants/${v1.id}`, ADMIN, { version: 1, color: 'Red' });
    const res = await call('patch', `/variants/${v1.id}`, ADMIN, { version: 1, color: 'Blue' });
    expect(res.status).toBe(409);
    expect(res.body.error.details.current).toMatchObject({ id: v1.id, color: 'Red', version: 2 });
    await prisma.productVariant.update({ where: { id: v2.id }, data: { deletedAt: new Date() } });
    await fn.refreshProducts(prisma, [p.id]);
    expect((await call('patch', `/variants/${v2.id}`, ADMIN, { version: 1, color: 'x' })).status).toBe(404);
    expect((await call('patch', '/variants/999999', ADMIN, { version: 1, color: 'x' })).status).toBe(404);
    expect((await call('post', '/products/999999/variants', ADMIN, { size: '1 kg' })).status).toBe(404);
  });

  it('a soft-deleted variant frees its SKU and options for a new variant', async () => {
    const sku = `FREE-${uniq()}`.toUpperCase();
    const p = await create({ name: 'Reuse SKU', variants: [{ sku, size: '1 kg' }] });
    expect((await call('post', `/products/${p.id}/variants`, ADMIN, { sku, size: '1 kg' })).body.error.code).toBe('SKU_EXISTS');
    await prisma.productVariant.update({ where: { id: p.variants[0]!.id }, data: { deletedAt: new Date() } });
    expect((await call('post', `/products/${p.id}/variants`, ADMIN, { sku, size: '1 kg' })).status).toBe(201);
  });
});

describe('pricing (PATCH /variants/:id/pricing)', () => {
  it('sets price/MRP/cost, stamps approval, refreshes the aggregates and audits before/after', async () => {
    const p = await create({ name: 'Priced', variants: [{ size: '1 kg' }, { size: '2 kg' }] });
    const [v1, v2] = p.variants as [{ id: number }, { id: number }];
    const res = await call('patch', `/variants/${v1.id}/pricing`, ADMIN, { price: 44_900, mrp: 49_900, costPrice: 30_000, version: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ price: 44_900, mrp: 49_900, costPrice: 30_000, version: 2 });
    expect(res.body.priceApprovedAt).not.toBeNull();
    await setPrice(v2.id, 89_900);
    expect(await product(p.id)).toMatchObject({ minPrice: 44_900, maxPrice: 89_900, maxMrp: 49_900 });
    await setPrice(v1.id, 99_900, 99_900);
    expect(await product(p.id)).toMatchObject({ minPrice: 89_900, maxPrice: 99_900, maxMrp: 99_900 });
    const audits = await prisma.auditLog.findMany({ where: { action: 'variant.price_update', entityId: String(v1.id) }, orderBy: { id: 'asc' } });
    expect(audits.map((a) => [a.before, a.after])).toEqual([
      [{ price: null, mrp: null, costPrice: null }, { price: 44_900, mrp: 49_900, costPrice: 30_000 }],
      [{ price: 44_900, mrp: 49_900, costPrice: 30_000 }, { price: 99_900, mrp: 99_900, costPrice: 30_000 }],   // cost kept when omitted
    ]);
    expect(await drift()).toBe(0n);
  });

  it.each([
    ['MRP below price', { price: 500, mrp: 499 }],
    ['zero price', { price: 0, mrp: null }],
    ['fractional paise', { price: 10.5, mrp: null }],
    ['negative cost', { price: 500, mrp: null, costPrice: -1 }],
    ['missing mrp key', { price: 500 }],
    ['stock smuggled in', { price: 500, mrp: null, onHand: 5 }],
    ['missing version', { price: 500, mrp: null, version: undefined }],
  ])('400 for %s; price unchanged', async (_l, body) => {
    const p = await create({ name: 'Pricing 400', variants: [{ size: '1 kg' }] });
    const res = await call('patch', `/variants/${p.variants[0]!.id}/pricing`, ADMIN, { version: 1, ...body });
    expect(res.status).toBe(400);
    expect((await variant(p.variants[0]!.id)).price).toBeNull();
  });

  it('boundary: MRP equal to the price is allowed; MRP null clears it', async () => {
    const p = await create({ name: 'Pricing Edge', variants: [{ size: '1 kg' }] });
    const id = p.variants[0]!.id;
    expect((await setPrice(id, 1, 1))).toMatchObject({ price: 1, mrp: 1 });
    expect((await setPrice(id, 100_000_000, null))).toMatchObject({ price: 100_000_000, mrp: null });
  });

  it('stale version → 409; unknown variant → 404', async () => {
    const p = await create({ name: 'Pricing 409', variants: [{ size: '1 kg' }] });
    const id = p.variants[0]!.id;
    await setPrice(id, 1000);
    const res = await call('patch', `/variants/${id}/pricing`, ADMIN, { price: 2000, mrp: null, version: 1 });
    expect([res.status, res.body.error.details.current.price]).toEqual([409, 1000]);
    expect((await call('patch', '/variants/999999/pricing', ADMIN, { price: 1, mrp: null, version: 1 })).status).toBe(404);
  });

  it('min_price changes in the same transaction: a concurrent reader never sees the product and its variants disagree', async () => {
    const p = await create({ name: 'Same TX', variants: [{ size: '1 kg' }, { size: '2 kg' }] });
    const [v1, v2] = p.variants as [{ id: number }, { id: number }];
    await setPrice(v1.id, 50_000);
    await setPrice(v2.id, 60_000);
    let stop = false, reads = 0;
    const mismatches: unknown[] = [];
    const reader = (async () => {
      while (!stop) {
        // one statement = one snapshot: the stored aggregate and the live minimum must agree in every snapshot
        const [row] = await prisma.$queryRaw<{ stored: number; live: number }[]>`
          SELECT p.min_price AS stored, (SELECT min(price) FROM product_variants WHERE product_id = p.id AND is_active AND deleted_at IS NULL) AS live
            FROM products p WHERE p.id = ${p.id}`;
        reads++;
        if (row!.stored !== row!.live) mismatches.push(row);
      }
    })();
    for (let i = 0; i < 30; i++) await setPrice(i % 2 ? v1.id : v2.id, 10_000 + Math.floor(Math.random() * 90_000));
    stop = true;
    await reader;
    expect(reads).toBeGreaterThan(30);
    expect(mismatches).toEqual([]);
  });
});

describe('concurrency and lock order', () => {
  it('pricing, content edits and new variants on one product in parallel: no deadlocks, no 500s, no drift', async () => {
    const p = await create({ name: 'Contended', variants: [{ size: '1 kg' }, { size: '2 kg' }, { size: '3 kg' }] });
    const ids = p.variants.map((v) => v.id);
    const statuses: number[] = [];
    await Promise.all(Array.from({ length: 30 }, async (_, i) => {
      const id = ids[i % 3]!;
      const v = await variant(id);
      const res = i % 3 === 0 ? await call('patch', `/variants/${id}/pricing`, ADMIN, { price: 1000 + i, mrp: null, version: v.version })
        : i % 3 === 1 ? await call('patch', `/variants/${id}`, ADMIN, { version: v.version, isActive: i % 2 === 0 })
        : await call('post', `/products/${p.id}/variants`, ADMIN, { size: `${100 + i} gm` });
      statuses.push(res.status);
    }));
    expect(statuses.filter((s) => ![200, 201, 409].includes(s))).toEqual([]);
    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
    expect(await drift()).toBe(0n);
  });

  it('concurrent adds to a product with no variants yet get distinct generated SKUs (the product row serialises them)', async () => {
    const p = await create({ name: 'Empty Host' });
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => call('post', `/products/${p.id}/variants`, ADMIN, { size: `${i + 1} kg` })));
    expect(res.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect(res.map((r) => r.body.sku as string).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `P${p.id}-V${i + 1}`).sort());
    expect((await product(p.id)).activeVariantCount).toBe(10);
  });

  it('✅ product_aggregate_drift is empty after 1,000 random edits (pricing, content, new variants, stock)', async () => {
    const products = await Promise.all([0, 1, 2].map((i) => create({ name: `Drift ${i}`, variants: [{ size: '1 kg' }, { size: '2 kg' }, { size: '3 kg' }, { size: '4 kg' }] })));
    let next = 0;
    const outcomes = new Map<number, number>();
    const rnd = (n: number) => Math.floor(Math.random() * n);
    const worker = async () => {
      while (next < 1000) {
        const n = next++;
        const p = products[n % 3]!;
        const all = await prisma.productVariant.findMany({ where: { productId: p.id, deletedAt: null }, select: { id: true, version: true, price: true } });
        const v = all[rnd(all.length)]!;
        let status: number;
        switch (rnd(6)) {
          case 0: case 1: {
            const price = 1000 + rnd(100_000);
            status = (await call('patch', `/variants/${v.id}/pricing`, ADMIN, { price, mrp: rnd(2) ? price + rnd(5000) : null, version: v.version })).status;
            break;
          }
          case 2: status = (await call('patch', `/variants/${v.id}`, ADMIN, { version: v.version, isActive: rnd(4) > 0 })).status; break;
          case 3: status = (await call('patch', `/variants/${v.id}`, ADMIN, { version: v.version, sortOrder: rnd(100) })).status; break;
          case 4:
            status = all.length < 12 ? (await call('post', `/products/${p.id}/variants`, ADMIN, { size: `${n + 5} gm` })).status
              : (await call('patch', `/variants/${v.id}`, ADMIN, { version: v.version, isActive: true })).status;
            break;
          default:
            await prisma.$transaction((tx) => fn.adjustOnHand(tx, { rows: [{ variantId: v.id, kind: 'RECOUNT', quantity: rnd(50) }], actorId: ADMIN.id }));
            status = 200;
        }
        outcomes.set(status, (outcomes.get(status) ?? 0) + 1);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    const total = [...outcomes.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(1000);
    expect([...outcomes.keys()].filter((s) => ![200, 201, 409].includes(s))).toEqual([]);
    expect((outcomes.get(200) ?? 0) + (outcomes.get(201) ?? 0)).toBeGreaterThan(700);   // conflicts are possible, not dominant
    expect(await drift()).toBe(0n);
  }, 180_000);
});

describe('bulk content actions (POST /products/bulk)', () => {
  it('flags, ranks cleared on unmark, per-item results for unknown ids, one audit row', async () => {
    const a = await create({ name: 'Bulk A' }), b = await create({ name: 'Bulk B' });
    let res = await call('post', '/products/bulk', ADMIN, { action: 'markNew', ids: [b.id, a.id, 999_999, a.id] });
    expect(res.body.results).toEqual([{ id: a.id, ok: true }, { id: b.id, ok: true }, { id: 999_999, ok: false, error: { code: 'NOT_FOUND', message: 'Product not found' } }]);
    expect((await product(a.id)).isNewArrival).toBe(true);
    await prisma.product.update({ where: { id: a.id }, data: { newArrivalRank: 3 } });
    res = await call('post', '/products/bulk', ADMIN, { action: 'unmarkNew', ids: [a.id] });
    expect(res.body.results).toEqual([{ id: a.id, ok: true }]);
    expect(await product(a.id)).toMatchObject({ isNewArrival: false, newArrivalRank: null });
    await call('post', '/products/bulk', ADMIN, { action: 'markTrending', ids: [a.id] });
    expect((await product(a.id)).isTrending).toBe(true);
    await call('post', '/products/bulk', ADMIN, { action: 'unmarkTrending', ids: [a.id] });
    expect((await product(a.id)).isTrending).toBe(false);
    expect(await prisma.auditLog.count({ where: { actorId: ADMIN.id, action: { startsWith: 'product.bulk_' } } })).toBeGreaterThanOrEqual(4);
  });

  it('setCategory sets the matching type; setType clears a draft\'s mismatched category but refuses a live product', async () => {
    const draft = await create({ name: 'Bulk Draft', categoryId: catA1 });
    const live = await create({ name: 'Bulk Live', categoryId: catA1, variants: [{ size: '1 kg' }] });
    await makeActive(live.id);
    let res = await call('post', '/products/bulk', ADMIN, { action: 'setType', ids: [draft.id, live.id], typeId: typeB });
    expect(res.body.results).toEqual([{ id: draft.id, ok: true }, { id: live.id, ok: false, error: expect.objectContaining({ code: 'CATEGORY_TYPE_MISMATCH' }) }]);
    expect(await product(draft.id)).toMatchObject({ typeId: typeB, categoryId: null });
    expect(await product(live.id)).toMatchObject({ typeId: typeA, categoryId: catA1, status: 'ACTIVE' });
    res = await call('post', '/products/bulk', ADMIN, { action: 'setCategory', ids: [draft.id, live.id], categoryId: catB1 });
    expect(res.body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(await product(live.id)).toMatchObject({ typeId: typeB, categoryId: catB1 });
    // setType to the type the category already belongs to keeps it
    await call('post', '/products/bulk', ADMIN, { action: 'setType', ids: [live.id], typeId: typeB });
    expect((await product(live.id)).categoryId).toBe(catB1);
  });

  it.each([
    ['no ids', { action: 'markNew', ids: [] }],
    ['101 ids', { action: 'markNew', ids: Array.from({ length: 101 }, (_, i) => i + 1) }],
    ['unknown action', { action: 'delete', ids: [1] }],
    ['setType without typeId', { action: 'setType', ids: [1] }],
    ['extra field', { action: 'markNew', ids: [1], price: 1 }],
  ])('400 for %s', async (_l, body) => {
    expect((await call('post', '/products/bulk', ADMIN, body)).status).toBe(400);
  });

  it('boundary: exactly 100 ids is accepted; unknown taxonomy → 422 before any change', async () => {
    expect((await call('post', '/products/bulk', ADMIN, { action: 'markNew', ids: Array.from({ length: 100 }, (_, i) => 900_000 + i) })).status).toBe(200);
    expect((await call('post', '/products/bulk', ADMIN, { action: 'setCategory', ids: [1], categoryId: 999_999 })).body.error.code).toBe('TAXONOMY_NOT_FOUND');
    expect((await call('post', '/products/bulk', ADMIN, { action: 'setType', ids: [1], typeId: 999_999 })).body.error.code).toBe('TAXONOMY_NOT_FOUND');
  });
});

describe('delete product (DELETE /products/:id)', () => {
  it('a fresh draft is deleted with its variants, images, techniques and redirects; audited', async () => {
    const p = await create({ name: 'Delete Me', techniqueIds: [tech1], variants: [{ size: '1 kg' }] });
    await call('patch', `/products/${p.id}`, ADMIN, { version: 1, slug: `${p.slug}-new` });
    const res = await call('delete', `/products/${p.id}`);
    expect(res.status).toBe(204);
    expect(await prisma.product.findUnique({ where: { id: p.id } })).toBeNull();
    expect(await prisma.productVariant.count({ where: { productId: p.id } })).toBe(0);
    expect(await catalog.resolveProductSlug(p.slug)).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'product.delete', entityId: String(p.id) } })).toBe(1);
    expect((await call('delete', `/products/${p.id}`)).status).toBe(404);
  });

  it.each([
    ['published', async (id: number) => { await makeActive(id); }, 'it has been published'],
    ['imported', async (id: number) => { await prisma.product.update({ where: { id }, data: { importKey: `imp-${uniq()}` } }); }, 'it came from an import'],
    ['ordered', async (id: number, v: number) => { await prisma.productVariant.update({ where: { id: v }, data: { price: 1000, onHand: 5 } }); await prisma.$transaction((tx) => order(tx, { lines: [{ variantId: v, qty: 1 }], reserve: false })); void id; }, 'it is in orders'],
    ['in a cart', async (_id: number, v: number) => {
      const cart = await prisma.cart.create({ data: { tokenHash: uniq().padEnd(64, '0') } });
      await prisma.cartItem.create({ data: { cartId: cart.id, variantId: v, quantity: 1, addedPrice: 100 } });
    }, 'it is in shopping carts'],
    ['stock history', async (_id: number, v: number) => { await prisma.$transaction((tx) => fn.adjustOnHand(tx, { rows: [{ variantId: v, kind: 'RECOUNT', quantity: 2 }], actorId: null })); }, 'it has stock history'],
  ])('%s → 409 ARCHIVE_INSTEAD; nothing deleted', async (_l, arrange, reason) => {
    const p = await create({ name: 'Keep Me', variants: [{ size: '1 kg' }] });
    await arrange(p.id, p.variants[0]!.id);
    const res = await call('delete', `/products/${p.id}`);
    expect([res.status, res.body.error.code, res.body.error.details]).toEqual([409, 'ARCHIVE_INSTEAD', { reason }]);
    expect(await prisma.product.count({ where: { id: p.id } })).toBe(1);
    expect(await prisma.productVariant.count({ where: { productId: p.id } })).toBe(1);
  });

  it('STAFF → 403', async () => {
    const p = await create({ name: 'Staff Delete' });
    expect((await call('delete', `/products/${p.id}`, STAFF)).status).toBe(403);
  });
});

describe('search triggers', () => {
  it('own columns update the vector in the same transaction; variant changes are queued and the worker function rebuilds', async () => {
    const p = await create({ name: 'Ocean Pour Kit', variants: [{ sku: `OCN-${uniq()}`.toUpperCase(), size: '1 kg' }] });
    const matches = (q: string) => val<boolean>(prisma, `SELECT search_vector @@ plainto_tsquery('simple', $2) FROM products WHERE id = $1`, p.id, q);
    expect(await matches('ocean')).toBe(true);
    await call('patch', `/products/${p.id}`, ADMIN, { version: 1, name: 'Galaxy Pour Kit' });
    expect([await matches('galaxy'), await matches('ocean')]).toEqual([true, false]);
    await call('patch', `/variants/${p.variants[0]!.id}`, ADMIN, { version: 1, color: 'Turquoise' });
    expect(await matches('turquoise')).toBe(false);   // eventually consistent: queued, not yet rebuilt
    expect(Number(await val(prisma, `SELECT count(*) FROM search_reindex_queue WHERE product_id = $1`, p.id))).toBeGreaterThan(0);
    await prisma.$transaction((tx) => fn.processSearchQueue(tx));
    expect(await matches('turquoise')).toBe(true);
    expect(Number(await val(prisma, `SELECT count(*) FROM search_reindex_queue WHERE product_id = $1`, p.id))).toBe(0);
  });
});

describe('AT-10 re-run against the real catalogue endpoints', () => {
  it('STAFF: pricing, variant, bulk and product write endpoints → 403, audited, prices unchanged', async () => {
    const p = await create({ name: 'AT10', variants: [{ size: '1 kg' }] });
    const v = p.variants[0]!.id;
    await setPrice(v, 44_900);
    const attempts = [
      await call('patch', `/variants/${v}/pricing`, STAFF, { price: 1, mrp: null, version: 2 }),
      await call('patch', `/variants/${v}`, STAFF, { version: 2, label: 'cheap' }),
      await call('post', `/products/${p.id}/variants`, STAFF, { size: '9 kg' }),
      await call('post', '/products/bulk', STAFF, { action: 'markNew', ids: [p.id] }),
      await call('patch', `/products/${p.id}`, STAFF, { version: 1, name: 'x' }),
      await call('post', '/products', STAFF, { name: 'x' }),
    ];
    expect(attempts.map((a) => a.status)).toEqual([403, 403, 403, 403, 403, 403]);
    expect(attempts[0]!.body.error.details).toEqual({ permission: 'pricing:write' });
    expect(attempts[1]!.body.error.details).toEqual({ permission: 'catalog:write' });
    expect((await variant(v)).price).toBe(44_900);
    const logged = await prisma.auditLog.findMany({ where: { actorId: STAFF.id, action: 'security.admin_rejected', createdAt: { gte: new Date(Date.now() - 60_000) } }, orderBy: { id: 'desc' }, take: 6 });
    expect(logged.map((l) => (l.after as { path: string }).path).reverse()).toEqual([
      `/v1/admin/variants/${v}/pricing`, `/v1/admin/variants/${v}`, `/v1/admin/products/${p.id}/variants`, '/v1/admin/products/bulk', `/v1/admin/products/${p.id}`, '/v1/admin/products',
    ]);
  });

  it('ADMIN cannot change a price through any content endpoint (unknown key → 400), only through pricing', async () => {
    const p = await create({ name: 'AT10 Admin', variants: [{ size: '1 kg' }] });
    const v = p.variants[0]!.id;
    await setPrice(v, 44_900);
    const attempts = [
      await call('patch', `/variants/${v}`, ADMIN, { version: 2, price: 1 }),
      await call('patch', `/variants/${v}`, ADMIN, { version: 2, label: 'ok', mrp: 1 }),
      await call('post', `/products/${p.id}/variants`, ADMIN, { size: '2 kg', price: 1 }),
      await call('patch', `/products/${p.id}`, ADMIN, { version: 1, minPrice: 1 }),
      await call('post', '/products/bulk', ADMIN, { action: 'markNew', ids: [p.id], price: 1 }),
      await call('post', '/products', ADMIN, { name: 'smuggle', variants: [{ size: '1 kg', price: 1 }] }),
    ];
    expect(attempts.map((a) => a.status)).toEqual([400, 400, 400, 400, 400, 400]);
    expect(await variant(v)).toMatchObject({ price: 44_900, version: 2 });
    expect((await product(p.id)).minPrice).toBe(44_900);
    expect(await prisma.auditLog.count({ where: { actorId: ADMIN.id, action: 'security.admin_rejected', after: { path: ['code'], equals: 'VALIDATION_ERROR' } } })).toBeGreaterThanOrEqual(6);
  });

  it('every successful catalogue mutation in this file recorded an audit entry', () => {
    expect(missingAudit).toEqual([]);
  });
});

describe('constraint mapping (unit)', () => {
  it('maps known Prisma shapes and leaves unknown errors alone', () => {
    expect(catalogConstraintError({ code: 'P2002', meta: { modelName: 'ProductVariant', target: ['sku'] } })?.code).toBe('SKU_EXISTS');
    expect(catalogConstraintError({ code: 'P2002', meta: { modelName: 'ProductVariant', target: ['product_id', 'COALESCE(size'] } })?.code).toBe('VARIANT_OPTIONS_EXIST');
    expect(catalogConstraintError({ code: 'P2002', meta: { modelName: 'Product', target: ['slug'] } })?.code).toBe('SLUG_TAKEN');
    expect(catalogConstraintError({ code: 'P2003', meta: { constraint: 'products_category_matches_type_fk' } })?.code).toBe('CATEGORY_TYPE_MISMATCH');
    expect(catalogConstraintError({ code: 'P2003', meta: { constraint: 'product_techniques_technique_id_fkey' } })?.code).toBe('TAXONOMY_NOT_FOUND');
    expect(catalogConstraintError({ message: 'violates check constraint "variants_mrp_ck"' })?.code).toBe('MRP_BELOW_PRICE');
    expect(catalogConstraintError({ code: 'P2002', meta: { modelName: 'User', target: ['email'] } })).toBeUndefined();
    expect(catalogConstraintError(new Error('boom'))).toBeUndefined();
    expect(catalogConstraintError(null)).toBeUndefined();
  });
});
