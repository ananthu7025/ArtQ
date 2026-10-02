// Task 2.4: GET /admin/products (+ product type counts, categories) on real PostgreSQL + Redis.
// Contract (product.md §7.3): every product shows its real type name, a genuinely unassigned one is `type: null`
// ("Unassigned"), and "Unknown" never appears; image states are distinct.
import type { ProductListRow } from '@artq/shared';
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
import { imageState } from '../../src/catalog/list.js';
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
const CDN = 'https://cdn.test';

let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express;
let ADMIN: { token: string }, STAFF: { token: string };
let resin: number, frames: number, pigments: number, epoxy: number, teak: number;
const P: Record<string, { id: number; variantId: number }> = {};

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  const cache = new RedisSessionCache(redis);
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: 'http://localhost:3000', adminUrl: ADMIN_ORIGIN });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log: pino({ level: 'silent' }), hasRecentStepUp: (sid) => service.hasRecentStepUp(sid) });
  // renditions as the media service renders them for PUBLIC media: CDN URLs per width
  registerCatalogRoutes(admin, new CatalogService(prisma, (m) => ({ id: m.id, renditions: Object.fromEntries(Object.entries(m.renditions as Record<string, string>).map(([w, k]) => [w, `${CDN}/${k}`])) })));
  registerTaxonomyRoutes(admin, prisma);
  app = createApp({
    version: 't', origins: { storefront: ['http://localhost:3000'], admin: [ADMIN_ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }), admin.router],
  });
  [ADMIN, STAFF] = [await login('ADMIN'), await login('STAFF')];

  const type = (name: string, sort: number) => val<number>(prisma, `INSERT INTO product_types (name, slug, sort_order, updated_at) VALUES ($1,$2,$3,now()) RETURNING id`, name, name.toLowerCase(), sort);
  [resin, frames, pigments] = [await type('Resin', 1), await type('Frames', 2), await type('Pigments', 3)];
  epoxy = await val<number>(prisma, `INSERT INTO categories (type_id, name, slug, updated_at) VALUES ($1,'Epoxy','epoxy',now()) RETURNING id`, resin);
  teak = await val<number>(prisma, `INSERT INTO categories (type_id, name, slug, updated_at) VALUES ($1,'Teak','teak',now()) RETURNING id`, frames);

  // A catalogue covering every state the filters care about.
  P.live = await make({ name: 'Ocean Pour Epoxy Kit', categoryId: epoxy, sku: 'OCEAN-1KG', price: 89_900, count: 20, image: 'READY', live: true });
  P.lowStock = await make({ name: 'Teak Frame 8x10', categoryId: teak, sku: 'TEAK-810', price: 45_000, count: 2, image: 'READY' });
  P.processing = await make({ name: 'Gold Gel Pigment', typeId: pigments, sku: 'GOLD-GEL', price: 9_000, count: 0, image: 'PROCESSING' });
  P.failed = await make({ name: 'Silver Mica 50%', typeId: pigments, sku: 'MICA-SLV', image: 'FAILED' });
  P.unassigned = await make({ name: 'Mystery Import Row', sku: 'IMP-77', flags: ['SIZE_CONFLICT'] });
  P.archived = await make({ name: 'Old Coaster Mould', categoryId: epoxy, sku: 'MOULD-OLD', price: 19_900, count: 1 });
  await prisma.product.update({ where: { id: P.archived.id }, data: { status: 'ARCHIVED' } });
  // oversold: reserved beyond on hand
  await prisma.$executeRawUnsafe(`UPDATE product_variants SET reserved = on_hand + 2 WHERE id = $1`, P.archived.variantId);
  await fn.refreshProducts(prisma, [P.archived.id]);
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });

async function login(role: UserRole) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  await prisma.user.create({ data: { email, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword(PASSWORD) } });
  const res = await request(app).post('/v1/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email, password: PASSWORD });
  return { token: res.body.accessToken as string };
}
const get = (path: string, who: { token: string } | null = ADMIN) => {
  let r = request(app).get(`/v1/admin${path}`).set('Origin', ADMIN_ORIGIN);
  if (who) r = r.set('Authorization', `Bearer ${who.token}`);
  return r;
};
const list = async (qs = '') => {
  const res = await get(`/products${qs ? `?${qs}` : ''}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { data: ProductListRow[]; meta: { page: number; limit: number; total: number; totalPages: number } };
};
const names = async (qs: string) => (await list(qs)).data.map((r) => r.name).sort();

async function make(o: { name: string; typeId?: number; categoryId?: number; sku: string; price?: number; count?: number; image?: string; live?: boolean; flags?: string[] }) {
  const res = await request(app).post('/v1/admin/products').set('Origin', ADMIN_ORIGIN).set('Authorization', `Bearer ${ADMIN.token}`).send({
    name: o.name, ...(o.typeId ? { typeId: o.typeId } : {}), ...(o.categoryId ? { categoryId: o.categoryId } : {}), description: 'A real description.',
    variants: [{ sku: o.sku, size: '1 kg', weightG: 1100, weightSource: 'MEASURED' }],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = res.body.id as number, variantId = res.body.variants[0].id as number;
  if (o.price) await prisma.$executeRawUnsafe(`UPDATE product_variants SET price = $2 WHERE id = $1`, variantId, o.price);
  if (o.count !== undefined) await prisma.$transaction((tx) => fn.adjustOnHand(tx, { rows: [{ variantId, kind: 'RECOUNT', quantity: o.count! }], actorId: null }));
  if (o.image) {
    const media = await val<number>(prisma, `INSERT INTO media (key, visibility, kind, declared_mime, declared_size, owner_scope, status, renditions, updated_at)
      VALUES ($1,'PUBLIC','IMAGE','image/webp',10,'admin',$2::"MediaStatus",$3::jsonb,now()) RETURNING id`, `k-${uniq()}`, o.image,
      JSON.stringify(o.image === 'READY' ? { 160: `p/${id}-160.webp`, 640: `p/${id}-640.webp` } : {}));
    await prisma.$executeRawUnsafe(`INSERT INTO product_images (product_id, media_id, is_cover) VALUES ($1,$2,true)`, id, media);
  }
  if (o.flags) await prisma.product.update({ where: { id }, data: { dataFlags: o.flags } });
  if (o.live) await prisma.$executeRawUnsafe(`UPDATE products SET hsn_code='3907', gst_rate=18, tax_approved_at=now(), status='ACTIVE', is_publishable=true, published_at=now() WHERE id=$1`, id);
  await fn.refreshProducts(prisma, [id]);
  return { id, variantId };
}

describe('row DTO', () => {
  it('real type names, Unassigned as type null, never "Unknown"; price range, stock, readiness and deletability per row', async () => {
    const { data, meta } = await list('limit=100');
    expect(meta).toEqual({ page: 1, limit: 100, total: 6, totalPages: 1 });
    expect(JSON.stringify(data)).not.toMatch(/unknown/i);
    const row = (id: number) => data.find((r) => r.id === id)!;
    expect(row(P.live!.id)).toMatchObject({
      name: 'Ocean Pour Epoxy Kit', type: { id: resin, name: 'Resin' }, category: { id: epoxy, name: 'Epoxy' }, status: 'ACTIVE',
      isPublishable: true, readinessFailures: [], variantCount: 1, activeVariantCount: 1, priceRange: { min: 89_900, max: 89_900 },
      available: 20, lowStock: false, oversold: false, flags: [], deletable: false,
      image: { state: 'READY', url: `${CDN}/p/${P.live!.id}-160.webp` },
    });
    expect(row(P.unassigned!.id)).toMatchObject({ type: null, category: null, priceRange: null, available: 0, flags: ['SIZE_CONFLICT'], image: { state: 'MISSING', url: null } });
    expect(row(P.unassigned!.id).readinessFailures).toEqual(expect.arrayContaining(['taxonomy', 'no_image', 'has_flags']));
    expect(row(P.processing!.id)).toMatchObject({ type: { name: 'Pigments' }, category: null, image: { state: 'PROCESSING', url: null } });
    expect(row(P.failed!.id).image).toEqual({ state: 'FAILED', url: null });
    expect(row(P.lowStock!.id)).toMatchObject({ available: 2, lowStock: true, deletable: false });   // counted ⇒ stock history
    expect(row(P.archived!.id)).toMatchObject({ status: 'ARCHIVED', oversold: true, available: 0 });
    expect(new Set(data.map((r) => r.image.state))).toEqual(new Set(['READY', 'PROCESSING', 'FAILED', 'MISSING']));
  });

  it('a fresh draft with no history is deletable; serials continue across pages; boundaries of limit', async () => {
    const fresh = await make({ name: 'Brand New Draft', sku: 'NEW-1' });
    expect((await list('limit=100')).data.find((r) => r.id === fresh.id)!.deletable).toBe(true);
    const p1 = await list('limit=3&sort=name');
    const p3 = await list('limit=3&sort=name&page=3');
    expect(p1.data.map((r) => r.serial)).toEqual([1, 2, 3]);
    expect(p1.meta).toMatchObject({ total: 7, totalPages: 3 });
    expect(p3.data.map((r) => r.serial)).toEqual([7]);
    expect((await list('page=9')).data).toEqual([]);
    expect((await list('page=9')).meta.total).toBe(7);           // total stays right past the end
    expect((await list()).meta.limit).toBe(20);                  // default
    expect((await get('/products?limit=101')).status).toBe(400);
    expect((await get('/products?limit=0')).status).toBe(400);
    await prisma.productVariant.deleteMany({ where: { productId: fresh.id } });
    await prisma.product.delete({ where: { id: fresh.id } });
  });
});

describe('filters and sorting', () => {
  it('search matches name, slug and SKU, case-insensitively; % and _ are literal', async () => {
    expect(await names('q=ocean')).toEqual(['Ocean Pour Epoxy Kit']);
    expect(await names('q=teak-frame')).toEqual(['Teak Frame 8x10']);       // slug
    expect(await names('q=gold-gel')).toEqual(['Gold Gel Pigment']);        // slug and SKU
    expect(await names('q=mica-slv')).toEqual(['Silver Mica 50%']);         // SKU
    expect(await names('q=50%25')).toEqual(['Silver Mica 50%']);            // literal %
    expect(await names('q=_')).toEqual([]);
    expect((await get('/products?q=')).status).toBe(400);
  });

  it('type tab: a type id or unassigned', async () => {
    expect(await names(`type=${pigments}`)).toEqual(['Gold Gel Pigment', 'Silver Mica 50%']);
    expect(await names('type=unassigned')).toEqual(['Mystery Import Row']);
    expect(await names('type=999999')).toEqual([]);
    expect((await get('/products?type=unknown')).status).toBe(400);
  });

  it('status (one or several), stock, readiness, image state and flags', async () => {
    expect(await names('status=ACTIVE')).toEqual(['Ocean Pour Epoxy Kit']);
    expect((await names('status=ACTIVE,ARCHIVED'))).toEqual(['Ocean Pour Epoxy Kit', 'Old Coaster Mould']);
    expect((await get('/products?status=LIVE')).status).toBe(400);
    expect(await names('stock=in')).toEqual(['Ocean Pour Epoxy Kit', 'Teak Frame 8x10']);
    expect(await names('stock=low')).toEqual(['Teak Frame 8x10']);
    expect(await names('stock=oversold')).toEqual(['Old Coaster Mould']);
    expect(await names('stock=out')).toEqual(['Gold Gel Pigment', 'Mystery Import Row', 'Old Coaster Mould', 'Silver Mica 50%']);
    expect(await names('readiness=ready')).toEqual(['Ocean Pour Epoxy Kit']);
    expect((await names('readiness=blocked')).length).toBe(5);
    expect(await names('readiness=taxonomy')).toEqual(['Gold Gel Pigment', 'Mystery Import Row', 'Silver Mica 50%']);   // a type without a category fails too
    expect(await names('readiness=no_image')).toEqual(['Gold Gel Pigment', 'Mystery Import Row', 'Old Coaster Mould', 'Silver Mica 50%']);
    expect((await get('/products?readiness=nope')).status).toBe(400);
    expect(await names('imageState=ready')).toEqual(['Ocean Pour Epoxy Kit', 'Teak Frame 8x10']);
    expect(await names('imageState=processing')).toEqual(['Gold Gel Pigment']);
    expect(await names('imageState=failed')).toEqual(['Silver Mica 50%']);
    expect(await names('imageState=missing')).toEqual(['Mystery Import Row', 'Old Coaster Mould']);
    expect(await names('flag=SIZE_CONFLICT')).toEqual(['Mystery Import Row']);
    await prisma.productVariant.update({ where: { id: P.lowStock!.variantId }, data: { dataFlags: ['WEIGHT_ESTIMATED'] } });
    expect(await names('flag=WEIGHT_ESTIMATED')).toEqual(['Teak Frame 8x10']);   // variant flags count too
    await prisma.productVariant.update({ where: { id: P.lowStock!.variantId }, data: { dataFlags: [] } });
    expect(await names(`type=${pigments}&imageState=failed`)).toEqual(['Silver Mica 50%']);   // filters combine
    expect((await get('/products?flag=bad flag')).status).toBe(400);
    expect((await get('/products?extra=1')).status).toBe(400);
  });

  it('sorts by name, price (unpriced last), stock and recent update', async () => {
    expect((await list('sort=name&limit=100')).data.map((r) => r.name)).toEqual(['Gold Gel Pigment', 'Mystery Import Row', 'Ocean Pour Epoxy Kit', 'Old Coaster Mould', 'Silver Mica 50%', 'Teak Frame 8x10']);
    const byPrice = (await list('sort=price&limit=100')).data.map((r) => r.priceRange?.min ?? null);
    expect(byPrice).toEqual([9_000, 19_900, 45_000, 89_900, null, null]);
    expect((await list('sort=stock&limit=100')).data.map((r) => r.available).slice(-2)).toEqual([2, 20]);
    await prisma.product.update({ where: { id: P.failed!.id }, data: { tags: ['touched'] } });
    expect((await list('limit=1')).data[0]!.id).toBe(P.failed!.id);
    expect((await get('/products?sort=random')).status).toBe(400);
  });

  it('STAFF (catalog:read) can list; no token → 401', async () => {
    expect((await get('/products', STAFF)).status).toBe(200);
    expect((await get('/products', null)).status).toBe(401);
  });
});

describe('type tabs and categories', () => {
  it('counts per type (in sort order), Unassigned and All; without withCounts no counts', async () => {
    const res = await get('/product-types?withCounts=1', STAFF);
    expect(res.body).toEqual({
      data: [
        { id: resin, name: 'Resin', slug: 'resin', sortOrder: 1, isActive: true, productCount: 2 },
        { id: frames, name: 'Frames', slug: 'frames', sortOrder: 2, isActive: true, productCount: 1 },
        { id: pigments, name: 'Pigments', slug: 'pigments', sortOrder: 3, isActive: true, productCount: 2 },
      ],
      unassigned: 1, total: 6,
    });
    expect((await get('/product-types')).body.data[0]).not.toHaveProperty('productCount');
    expect((await get('/product-types?withCounts=yes')).status).toBe(400);
  });

  it('categories, optionally of one type', async () => {
    expect((await get('/categories')).body.data.map((c: { name: string }) => c.name)).toEqual(['Epoxy', 'Teak']);
    expect((await get(`/categories?typeId=${frames}`)).body.data).toEqual([{ id: teak, name: 'Teak', slug: 'teak', typeId: frames, isActive: true }]);
    expect((await get('/categories?typeId=abc')).status).toBe(400);
  });
});

describe('imageState mapping (unit)', () => {
  it.each([[null, 'MISSING'], ['READY', 'READY'], ['FAILED', 'FAILED'], ['REJECTED', 'FAILED'], ['PROCESSING', 'PROCESSING'], ['UPLOADED', 'PROCESSING'], ['PENDING_UPLOAD', 'PROCESSING']])('%s → %s', (s, e) => {
    expect(imageState(s)).toBe(e);
  });
});
