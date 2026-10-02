// Task 2.3: publication gate through the real /v1/admin routes, on real PostgreSQL + Redis.
// ✅ Each of the product.md §8.7 checks individually blocks publish.
import { READINESS } from '@artq/shared';
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
import * as fn from '../../src/db/functions.js';
import { runCatalogChecks } from '../../src/jobs/catalog-check.js';
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
let ADMIN: { id: number; token: string }, STAFF: { id: number; token: string };
let typeId: number, categoryId: number;

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
  app = createApp({
    version: 't', origins: { storefront: ['http://localhost:3000'], admin: [ADMIN_ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }), admin.router],
  });
  [ADMIN, STAFF] = [await login('ADMIN'), await login('STAFF')];
  const u = uniq();
  typeId = await val<number>(prisma, `INSERT INTO product_types (name, slug, updated_at) VALUES ('Resin','resin-${u}',now()) RETURNING id`);
  categoryId = await val<number>(prisma, `INSERT INTO categories (type_id, name, slug, updated_at) VALUES ($1,'Epoxy','epoxy-${u}',now()) RETURNING id`, typeId);
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });

async function login(role: UserRole) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  const u = await prisma.user.create({ data: { email, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword(PASSWORD) } });
  const res = await request(app).post('/v1/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { id: u.id, token: res.body.accessToken as string };
}
type Method = 'get' | 'post' | 'patch';
const call = (method: Method, path: string, who: { token: string } | null = ADMIN, body?: object) => {
  let r = request(app)[method](`/v1/admin${path}`).set('Origin', ADMIN_ORIGIN);
  if (who) r = r.set('Authorization', `Bearer ${who.token}`);
  return body ? r.send(body) : r;
};
const product = (id: number) => prisma.product.findUniqueOrThrow({ where: { id } });
const variant = (id: number) => prisma.productVariant.findUniqueOrThrow({ where: { id } });
const codes = (res: { body: { error?: { details?: { failures?: { code: string }[] } } } }) => res.body.error?.details?.failures?.map((f) => f.code);
const publish = (id: number, who = ADMIN) => call('post', `/products/${id}/publish`, who, {});

async function addImage(productId: number, o: { status?: string; visibility?: string; cover?: boolean } = {}) {
  const media = await val<number>(prisma, `INSERT INTO media (key, visibility, kind, declared_mime, declared_size, owner_scope, status, updated_at)
    VALUES ($1,$2::"MediaVisibility",'IMAGE','image/webp',10,'admin',$3::"MediaStatus",now()) RETURNING id`, `k-${uniq()}`, o.visibility ?? 'PUBLIC', o.status ?? 'READY');
  await prisma.$executeRawUnsafe(`INSERT INTO product_images (product_id, media_id, is_cover) VALUES ($1,$2,$3)`, productId, media, o.cover ?? true);
  return media;
}
async function recount(variantId: number, quantity = 5) {
  await prisma.$transaction((tx) => fn.adjustOnHand(tx, { rows: [{ variantId, kind: 'RECOUNT', quantity }], actorId: null }));
}

type Skip = 'tax' | 'image' | 'count' | 'price';
/** A draft that passes every check, built through the real endpoints where they exist (images/stock: tasks 2.5/2.8). */
async function readyDraft(skip: Skip[] = []) {
  const res = await call('post', '/products', ADMIN, {
    name: `Ready ${uniq()}`, categoryId, description: 'Crystal-clear 2:1 epoxy for coasters and art.',
    variants: [{ size: '1 kg', weightG: 1150, weightSource: 'MEASURED' }],
  });
  expect(res.status).toBe(201);
  const p = res.body as { id: number; variants: { id: number }[] };
  const v = p.variants[0]!.id;
  if (!skip.includes('price')) expect((await call('patch', `/variants/${v}/pricing`, ADMIN, { price: 89_900, mrp: 99_900, version: 1 })).status).toBe(200);
  if (!skip.includes('tax')) expect((await call('post', `/products/${p.id}/tax-approval`, ADMIN, { hsnCode: '3907', gstRate: 18 })).status).toBe(200);
  if (!skip.includes('count')) await recount(v);
  if (!skip.includes('image')) await addImage(p.id);
  return { id: p.id, variantId: v };
}
async function live() {
  const p = await readyDraft();
  expect((await publish(p.id)).status).toBe(200);
  return p;
}

describe('✅ each product.md §8.7 check individually blocks publish', () => {
  it('a product passing every check publishes: ACTIVE, publishable, first-publication date, version bump, audit', async () => {
    const p = await readyDraft();
    const before = await product(p.id);
    expect((await call('get', `/products/${p.id}/readiness`, STAFF)).body).toEqual({ ready: true, failures: [] });
    const res = await publish(p.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ACTIVE', readiness: { ready: true, failures: [] } });
    const after = await product(p.id);
    expect(after).toMatchObject({ status: 'ACTIVE', isPublishable: true, version: before.version + 1 });
    expect(after.publishedAt).not.toBeNull();
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'product.publish', entityId: String(p.id) } }))).toMatchObject({ actorId: ADMIN.id, before: { status: 'DRAFT' }, after: { status: 'ACTIVE' } });
  });

  const cases: [string, keyof typeof READINESS, (p: { id: number; variantId: number }) => Promise<unknown>, Skip[]?][] = [
    ['type & category missing', 'taxonomy', async (p) => call('patch', `/products/${p.id}`, ADMIN, { version: (await product(p.id)).version, typeId: null, categoryId: null })],
    ['description empty (whitespace only)', 'no_description', async (p) => call('patch', `/products/${p.id}`, ADMIN, { version: (await product(p.id)).version, description: '   ' })],
    ['description flagged as copied (DESCRIPTION_SUSPECT_COPY)', 'has_flags', (p) => prisma.product.update({ where: { id: p.id }, data: { dataFlags: ['DESCRIPTION_SUSPECT_COPY'] } })],
    ['tax not approved', 'no_tax', async () => {}, ['tax']],
    ['tax set but approval withdrawn', 'no_tax', (p) => prisma.product.update({ where: { id: p.id }, data: { taxApprovedAt: null } })],
    ['no image at all', 'no_image', async () => {}, ['image']],
    ['cover still processing', 'no_image', (p) => addImage(p.id, { status: 'PROCESSING' }), ['image']],
    ['cover failed processing', 'no_image', (p) => addImage(p.id, { status: 'FAILED' }), ['image']],
    ['a ready image that is not the cover', 'no_image', (p) => addImage(p.id, { cover: false }), ['image']],
    ['a private cover image', 'no_image', (p) => addImage(p.id, { visibility: 'PRIVATE' }), ['image']],
    ['no active variant', 'no_active_variant', (p) => call('patch', `/variants/${p.variantId}`, ADMIN, { version: 3, isActive: false })],
    ['an active variant without a price', 'no_price_or_size', async () => {}, ['price']],
    ['an active variant without a size unit', 'no_price_or_size', (p) => prisma.productVariant.update({ where: { id: p.variantId }, data: { netQuantity: null, netUnit: null } })],
    ['stock never counted (ambiguous import stock)', 'stock_uncounted', async () => {}, ['count']],
    ['estimated weight', 'shipping_data', (p) => call('patch', `/variants/${p.variantId}`, ADMIN, { version: 3, weightSource: 'ESTIMATED' })],
    ['no weight', 'shipping_data', (p) => call('patch', `/variants/${p.variantId}`, ADMIN, { version: 3, weightG: null })],
    ['bulky without dimensions', 'shipping_data', (p) => call('patch', `/variants/${p.variantId}`, ADMIN, { version: 3, shippingClass: 'BULKY' })],
    ['a variant flagged PRICE_MISSING', 'variant_flags', (p) => prisma.productVariant.update({ where: { id: p.variantId }, data: { dataFlags: ['PRICE_MISSING'] } })],
  ];

  it.each(cases)('%s → 422 NOT_PUBLISHABLE [%s] only; stays DRAFT; the evaluation is stored', async (_label, code, breakIt, skip = []) => {
    const p = await readyDraft(skip);
    await breakIt(p);
    const res = await publish(p.id);
    expect([res.status, res.body.error.code]).toEqual([422, 'NOT_PUBLISHABLE']);
    expect(codes(res)).toEqual([code]);
    expect(res.body.error.details.failures[0]).toEqual({ code, check: READINESS[code].check, fix: READINESS[code].fix });
    const after = await product(p.id);
    expect(after).toMatchObject({ status: 'DRAFT', isPublishable: false, publishedAt: null });
    expect((after.readiness as { failures: string[] }).failures).toEqual([code]);
    expect(codes({ body: { error: { details: (await call('get', `/products/${p.id}/readiness`)).body } } })).toEqual([code]);
  });

  it('every failure code the database can report has a label and a fix', async () => {
    const fnSql = await val<string>(prisma, `SELECT pg_get_functiondef('product_readiness_failures(products)'::regprocedure)`);
    const dbCodes = [...fnSql.matchAll(/THEN '([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(dbCodes).toEqual(Object.keys(READINESS).sort());
  });

  it('several problems are all reported, in check order; an inactive unpriced variant does not block', async () => {
    const p = await readyDraft(['tax', 'image', 'count']);
    expect(codes(await publish(p.id))).toEqual(['no_tax', 'no_image', 'stock_uncounted']);
    const q = await readyDraft();
    expect((await call('post', `/products/${q.id}/variants`, ADMIN, { size: '5 kg', isActive: false })).status).toBe(201);
    expect((await publish(q.id)).status).toBe(200);
  });
});

describe('status transitions', () => {
  it('publish is idempotent; unpublish → DRAFT keeps the first publication date; archive and back', async () => {
    const p = await live();
    const { publishedAt: first, version } = await product(p.id);
    expect((await publish(p.id)).status).toBe(200);
    expect((await product(p.id)).version).toBe(version);   // no change, no version bump
    expect(await prisma.auditLog.count({ where: { action: 'product.publish', entityId: String(p.id), after: { path: ['unchanged'], equals: true } } })).toBe(1);

    expect((await call('post', `/products/${p.id}/unpublish`, ADMIN, {})).body.status).toBe('DRAFT');
    expect((await publish(p.id)).body.status).toBe('ACTIVE');
    expect((await product(p.id)).publishedAt).toEqual(first);
    expect((await call('post', `/products/${p.id}/archive`, ADMIN, {})).body.status).toBe('ARCHIVED');
    expect((await publish(p.id)).body.status).toBe('ACTIVE');          // an archived product can come back if still ready
    await call('post', `/products/${p.id}/archive`, ADMIN, {});
    expect((await call('post', `/products/${p.id}/unpublish`, ADMIN, {})).body.status).toBe('DRAFT');
    expect((await call('post', `/products/${p.id}/archive`, ADMIN, {})).body.status).toBe('ARCHIVED');   // a draft can be archived too
  });

  it('negative: unknown product 404; a body → 400; STAFF → 403 on every publication endpoint but may read readiness', async () => {
    const p = await readyDraft();
    for (const a of ['publish', 'unpublish', 'archive']) {
      expect((await call('post', `/products/999999/${a}`, ADMIN, {})).status).toBe(404);
      expect((await call('post', `/products/${p.id}/${a}`, ADMIN, { status: 'ACTIVE' })).status).toBe(400);
      expect((await call('post', `/products/${p.id}/${a}`, STAFF, {})).status).toBe(403);
    }
    expect((await call('post', `/products/${p.id}/tax-approval`, STAFF, { hsnCode: '3907', gstRate: 18 })).status).toBe(403);
    expect((await call('post', '/products/bulk', STAFF, { action: 'publish', ids: [p.id] })).status).toBe(403);
    expect((await call('get', `/products/${p.id}/readiness`, STAFF)).status).toBe(200);
    expect((await call('get', '/products/999999/readiness')).status).toBe(404);
    expect((await product(p.id)).status).toBe('DRAFT');
  });

  it('the database trigger is the backstop: a direct status change on an unready product is refused', async () => {
    const p = await readyDraft(['image']);
    await expect(prisma.$executeRawUnsafe(`UPDATE products SET status='ACTIVE', is_publishable=true, published_at=now() WHERE id=$1`, p.id)).rejects.toThrow(/NOT_PUBLISHABLE: no_image/);
  });
});

describe('edit-guard: a live product must keep passing (unpublish first)', () => {
  it.each([
    ['clearing the description', (p: { id: number; variantId: number }, v: number) => call('patch', `/products/${p.id}`, ADMIN, { version: v, description: '' }), 'no_description'],
    ['turning off the only variant', (p: { id: number; variantId: number }) => call('patch', `/variants/${p.variantId}`, ADMIN, { version: 3, isActive: false }), 'no_active_variant'],
    ['marking the weight estimated', (p: { id: number; variantId: number }) => call('patch', `/variants/${p.variantId}`, ADMIN, { version: 3, weightSource: 'ESTIMATED' }), 'shipping_data'],
    ['making it bulky without dimensions', (p: { id: number; variantId: number }) => call('patch', `/variants/${p.variantId}`, ADMIN, { version: 3, shippingClass: 'BULKY' }), 'shipping_data'],
    ['removing the size unit', (p: { id: number; variantId: number }) => call('patch', `/variants/${p.variantId}`, ADMIN, { version: 3, netQuantity: null, netUnit: null }), 'no_price_or_size'],
  ])('%s → 409 UNPUBLISH_FIRST [%s]; nothing changes', async (_l, change, code) => {
    const p = await live();
    const [pb, vb] = [await product(p.id), await variant(p.variantId)];
    const res = await change(p, pb.version) as { status: number; body: { error: { code: string } } };
    expect([res.status, res.body.error.code]).toEqual([409, 'UNPUBLISH_FIRST']);
    expect(codes(res)).toEqual([code]);
    expect(await product(p.id)).toMatchObject({ status: 'ACTIVE', version: pb.version, description: pb.description });
    expect(await variant(p.variantId)).toMatchObject({ version: vb.version, isActive: true, weightSource: 'MEASURED', shippingClass: 'STANDARD' });
    expect(await val(prisma, `SELECT count(*)::int FROM published_not_ready WHERE id = $1`, p.id)).toBe(0);
  });

  it('removing the category of a live product → 409 UNPUBLISH_FIRST (database check as backstop)', async () => {
    const p = await live();
    const res = await call('patch', `/products/${p.id}`, ADMIN, { version: (await product(p.id)).version, typeId: null, categoryId: null });
    expect([res.status, res.body.error.code]).toEqual([409, 'UNPUBLISH_FIRST']);
    expect((await product(p.id)).categoryId).toBe(categoryId);
  });

  it('harmless edits on a live product are fine; after unpublishing, the breaking edit is allowed', async () => {
    const p = await live();
    expect((await call('patch', `/products/${p.id}`, ADMIN, { version: (await product(p.id)).version, name: 'Renamed Live', tags: ['resin'] })).status).toBe(200);
    expect((await call('patch', `/variants/${p.variantId}/pricing`, ADMIN, { price: 79_900, mrp: null, version: (await variant(p.variantId)).version })).status).toBe(200);
    expect((await call('post', `/products/${p.id}/tax-approval`, ADMIN, { hsnCode: '39073010', gstRate: 5 })).status).toBe(200);
    await call('post', `/products/${p.id}/unpublish`, ADMIN, {});
    const res = await call('patch', `/variants/${p.variantId}`, ADMIN, { version: (await variant(p.variantId)).version, weightSource: 'ESTIMATED' });
    expect(res.status).toBe(200);
    expect(((await product(p.id)).readiness as { failures: string[] }).failures).toEqual(['shipping_data']);
  });

  it('a new variant on a live product starts inactive; it can be activated once it passes', async () => {
    const p = await live();
    const add = await call('post', `/products/${p.id}/variants`, ADMIN, { size: '5 kg', weightG: 5600, weightSource: 'MEASURED' });
    expect([add.status, add.body.isActive]).toEqual([201, false]);
    const v = add.body.id as number;
    const on = () => variant(v).then((x) => call('patch', `/variants/${v}`, ADMIN, { version: x.version, isActive: true }));
    const first = await on();
    expect([first.status, codes(first)]).toEqual([409, ['no_price_or_size', 'stock_uncounted']]);
    await call('patch', `/variants/${v}/pricing`, ADMIN, { price: 399_900, mrp: null, version: (await variant(v)).version });
    await recount(v, 2);
    expect((await on()).status).toBe(200);
    expect(await product(p.id)).toMatchObject({ status: 'ACTIVE', activeVariantCount: 2 });
    // explicitly adding an active, unready variant to a live product is refused
    expect(codes(await call('post', `/products/${p.id}/variants`, ADMIN, { size: '10 kg', isActive: true }))).toEqual(['no_price_or_size', 'stock_uncounted', 'shipping_data']);
  });

  it('publish racing a breaking edit never leaves a live product failing a check', async () => {
    for (let i = 0; i < 10; i++) {
      const p = await readyDraft();
      const r = await Promise.all([publish(p.id), call('patch', `/variants/${p.variantId}`, ADMIN, { version: 3, isActive: false })]);
      expect(r.map((x) => x.status).every((s) => [200, 409, 422].includes(s))).toBe(true);
    }
    expect(await val(prisma, `SELECT count(*)::int FROM published_not_ready`)).toBe(0);
  });
});

describe('tax approval (POST /products/:id/tax-approval)', () => {
  it('sets and approves HSN + GST, records who, audits before/after', async () => {
    const p = await readyDraft(['tax']);
    const res = await call('post', `/products/${p.id}/tax-approval`, ADMIN, { hsnCode: ' 3907 ', gstRate: 18 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hsnCode: '3907', gstRate: 18 });
    expect(await product(p.id)).toMatchObject({ taxApprovedBy: ADMIN.id });
    expect((await product(p.id)).taxApprovedAt).not.toBeNull();
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'product.tax_approve', entityId: String(p.id) } });
    expect([a.before, a.after]).toEqual([{ hsnCode: null, gstRate: null, approved: false }, { hsnCode: '3907', gstRate: 18 }]);
  });

  it.each([
    [{ hsnCode: '3907', gstRate: 0 }, 200], [{ hsnCode: '390730', gstRate: 40 }, 200], [{ hsnCode: '39073010', gstRate: 0.25 }, 200],
    [{ hsnCode: '390', gstRate: 18 }, 400], [{ hsnCode: '39073', gstRate: 18 }, 400], [{ hsnCode: '3907301', gstRate: 18 }, 400], [{ hsnCode: '39AB', gstRate: 18 }, 400],
    [{ hsnCode: '3907', gstRate: 40.01 }, 400], [{ hsnCode: '3907', gstRate: -1 }, 400], [{ hsnCode: '3907', gstRate: 18.255 }, 400],
    [{ hsnCode: '3907' }, 400], [{ hsnCode: '3907', gstRate: 18, approvedBy: 1 }, 400],
  ])('%j → %i', async (body, status) => {
    const p = await readyDraft(['tax']);
    expect((await call('post', `/products/${p.id}/tax-approval`, ADMIN, body)).status).toBe(status);
  });

  it('unknown product → 404', async () => {
    expect((await call('post', '/products/999999/tax-approval', ADMIN, { hsnCode: '3907', gstRate: 18 })).status).toBe(404);
  });
});

describe('bulk publication', () => {
  it('per-item results: ready ones publish, unready ones report their failures, unknown ids are not found', async () => {
    const [a, b] = [await readyDraft(), await readyDraft(['image'])];
    const res = await call('post', '/products/bulk', ADMIN, { action: 'publish', ids: [b.id, a.id, 999_999] });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { id: a.id, ok: true },
      { id: b.id, ok: false, error: { code: 'NOT_PUBLISHABLE', message: 'This product is not ready to publish', details: { failures: [{ code: 'no_image', check: 'Image', fix: READINESS.no_image.fix }] } } },
      { id: 999_999, ok: false, error: { code: 'NOT_FOUND', message: 'Product not found' } },
    ]);
    expect((await product(a.id)).status).toBe('ACTIVE');
    expect((await call('post', '/products/bulk', ADMIN, { action: 'archive', ids: [a.id, b.id] })).body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect((await call('post', '/products/bulk', ADMIN, { action: 'unpublish', ids: [a.id] })).body.results).toEqual([{ id: a.id, ok: true }]);
    expect(await prisma.auditLog.count({ where: { action: { in: ['product.bulk_publish', 'product.bulk_archive', 'product.bulk_unpublish'] }, actorId: ADMIN.id } })).toBe(3);
  });
});

describe('nightly catalogue check', () => {
  it('a live product whose cover fails later raises one PUBLISHED_NOT_READY exception; drift is repaired and reported', async () => {
    const p = await readyDraft(['image']);
    const media = await addImage(p.id);
    await publish(p.id);
    await prisma.$executeRawUnsafe(`UPDATE media SET status = 'FAILED' WHERE id = $1`, media);   // a change the edit-guard cannot see
    await prisma.$executeRawUnsafe(`UPDATE products SET min_price = 1 WHERE id = $1`, p.id);       // simulated drift
    const r1 = await runCatalogChecks(prisma);
    expect(r1.publishedNotReady).toBeGreaterThanOrEqual(1);
    expect(r1.driftRepaired).toContain(p.id);
    expect((await product(p.id)).minPrice).toBe(89_900);
    expect(await val(prisma, `SELECT count(*)::int FROM product_aggregate_drift`)).toBe(0);
    const exc = await prisma.paymentException.findMany({ where: { type: 'PUBLISHED_NOT_READY', dedupeKey: { startsWith: `PUBLISHED_NOT_READY:${p.id}:` } } });
    expect(exc).toHaveLength(1);
    expect(exc[0]!.details).toEqual({ product_id: p.id, failures: ['no_image'] });
    await runCatalogChecks(prisma);   // same problem next night: no duplicate
    expect(await prisma.paymentException.count({ where: { type: 'PUBLISHED_NOT_READY', dedupeKey: { startsWith: `PUBLISHED_NOT_READY:${p.id}:` } } })).toBe(1);
  });

  it('nothing to report → no exceptions, no repairs', async () => {
    await prisma.$executeRawUnsafe(`UPDATE products SET status = 'DRAFT' WHERE id IN (SELECT id FROM published_not_ready)`);
    const before = await prisma.paymentException.count();
    expect(await runCatalogChecks(prisma)).toEqual({ publishedNotReady: 0, driftRepaired: [] });
    expect(await prisma.paymentException.count()).toBe(before);
  });
});

describe('audit', () => {
  it('every successful publication mutation recorded an audit entry', () => { expect(missingAudit).toEqual([]); });
});
