// Task 2.5 API additions for the product editor: images, relations, sanitised description, "changed by", techniques.
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
let categoryId: number;

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
  registerTaxonomyRoutes(admin, prisma);
  app = createApp({
    version: 't', origins: { storefront: ['http://localhost:3000'], admin: [ADMIN_ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }), admin.router],
  });
  [ADMIN, STAFF] = [await login('ADMIN', 'Anu'), await login('STAFF')];
  const typeId = await val<number>(prisma, `INSERT INTO product_types (name, slug, updated_at) VALUES ('Frames','frames',now()) RETURNING id`);
  categoryId = await val<number>(prisma, `INSERT INTO categories (type_id, name, slug, updated_at) VALUES ($1,'Teak','teak',now()) RETURNING id`, typeId);
  for (const [i, n] of ['Resin Art', 'Photo Framing', 'Flower Preservation'].entries()) {
    await prisma.$executeRawUnsafe(`INSERT INTO techniques (name, slug, sort_order, updated_at) VALUES ($1,$2,$3,now())`, n, n.toLowerCase().replace(/ /g, '-'), 3 - i);
  }
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });

async function login(role: UserRole, name?: string) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  const u = await prisma.user.create({ data: { email, name: name ?? null, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword(PASSWORD) } });
  const res = await request(app).post('/v1/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email, password: PASSWORD });
  return { id: u.id, token: res.body.accessToken as string };
}
type Method = 'get' | 'post' | 'patch' | 'put';
const call = (method: Method, path: string, who: { token: string } | null = ADMIN, body?: object) => {
  let r = request(app)[method](`/v1/admin${path}`).set('Origin', ADMIN_ORIGIN);
  if (who) r = r.set('Authorization', `Bearer ${who.token}`);
  return body ? r.send(body) : r;
};
const create = async (body: object = {}) => {
  const res = await call('post', '/products', ADMIN, { name: `Frame ${uniq()}`, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: number; version: number; variants: { id: number }[] };
};
const version = async (id: number) => (await prisma.product.findUniqueOrThrow({ where: { id } })).version;
async function media(o: { status?: string; visibility?: string; scope?: string; kind?: string } = {}) {
  return val<number>(prisma, `INSERT INTO media (key, visibility, kind, declared_mime, declared_size, owner_scope, status, updated_at)
    VALUES ($1,$2::"MediaVisibility",$3::"MediaKind",'image/webp',10,$4,$5::"MediaStatus",now()) RETURNING id`,
    `k-${uniq()}`, o.visibility ?? 'PUBLIC', o.kind ?? 'IMAGE', o.scope ?? 'admin', o.status ?? 'READY');
}

describe('description (rich text, sanitised on save)', () => {
  it('is cleaned on create and update; markup with no text counts as no description', async () => {
    const p = await create({ description: '<p onclick="x()">Pour <b>slowly</b></p><script>alert(1)</script>' });
    expect((await call('get', `/products/${p.id}`)).body.description).toBe('<p>Pour <strong>slowly</strong></p>');
    const res = await call('patch', `/products/${p.id}`, ADMIN, { version: await version(p.id), description: '<p> </p><br>' });
    expect(res.body.description).toBeNull();
    expect(res.body.readiness.failures.map((f: { code: string }) => f.code)).toContain('no_description');
  });
});

describe('relations', () => {
  it('set, reorder and replace per kind; names returned; duplicates collapse', async () => {
    const [p, a, b, c] = [await create(), await create({ name: 'Resin Kit' }), await create({ name: 'Mould Set' }), await create({ name: 'Pigment Pack' })];
    let res = await call('patch', `/products/${p.id}`, ADMIN, { version: await version(p.id), relations: [
      { productId: b.id, kind: 'FREQUENTLY_BOUGHT_TOGETHER' }, { productId: a.id, kind: 'FREQUENTLY_BOUGHT_TOGETHER' },
      { productId: c.id, kind: 'SIMILAR' }, { productId: a.id, kind: 'FREQUENTLY_BOUGHT_TOGETHER' },
    ] });
    expect(res.status).toBe(200);
    expect(res.body.relations.map((r: { name: string; kind: string }) => `${r.kind}:${r.name}`)).toEqual(['FREQUENTLY_BOUGHT_TOGETHER:Mould Set', 'FREQUENTLY_BOUGHT_TOGETHER:Resin Kit', 'SIMILAR:Pigment Pack']);
    res = await call('patch', `/products/${p.id}`, ADMIN, { version: await version(p.id), relations: [{ productId: c.id, kind: 'SIMILAR' }] });
    expect(res.body.relations).toHaveLength(1);
    expect((await call('patch', `/products/${p.id}`, ADMIN, { version: await version(p.id), relations: [] })).body.relations).toEqual([]);
    expect((await create({ relations: [{ productId: a.id, kind: 'SIMILAR' }] }))).toBeTruthy();
  });

  it.each([
    ['itself', (self: number) => [{ productId: self, kind: 'SIMILAR' }], 422, 'RELATION_SELF'],
    ['an unknown product', () => [{ productId: 999_999, kind: 'SIMILAR' }], 422, 'RELATION_NOT_FOUND'],
    ['an unknown kind', () => [{ productId: 1, kind: 'RIVAL' }], 400, 'VALIDATION_ERROR'],
    ['41 relations', () => Array.from({ length: 41 }, (_, i) => ({ productId: i + 1, kind: 'SIMILAR' })), 400, 'VALIDATION_ERROR'],
  ])('relating to %s → %i %s; nothing changes', async (_l, rel, status, code) => {
    const p = await create();
    const res = await call('patch', `/products/${p.id}`, ADMIN, { version: await version(p.id), relations: rel(p.id) });
    expect([res.status, res.body.error.code]).toEqual([status, code]);
    expect(await version(p.id)).toBe(p.version);
  });
});

describe('images (PUT /products/:id/images)', () => {
  it('sets the ordered list with one cover, claims the media, keeps the content version, audits', async () => {
    const p = await create();
    const [m1, m2] = [await media(), await media({ status: 'PROCESSING' })];
    const res = await call('put', `/products/${p.id}/images`, ADMIN, { images: [{ mediaId: m2, alt: 'Side view', isCover: false }, { mediaId: m1, alt: 'Front', isCover: true }] });
    expect(res.status).toBe(200);
    expect(res.body.images.map((i: { mediaId: number; isCover: boolean; alt: string; sortOrder: number }) => [i.mediaId, i.isCover, i.alt, i.sortOrder])).toEqual([[m2, false, 'Side view', 0], [m1, true, 'Front', 1]]);
    expect(res.body.version).toBe(p.version);   // images are not content: the editor's version guard is unchanged
    expect((await prisma.media.findUniqueOrThrow({ where: { id: m1 } })).claimedAt).not.toBeNull();
    // reorder, then clear
    expect((await call('put', `/products/${p.id}/images`, ADMIN, { images: [{ mediaId: m1, isCover: true }, { mediaId: m2, isCover: false }] })).body.images[0].mediaId).toBe(m1);
    expect((await call('put', `/products/${p.id}/images`, ADMIN, { images: [] })).body.images).toEqual([]);
    expect(await prisma.auditLog.count({ where: { action: 'product.images', entityId: String(p.id) } })).toBe(3);
  });

  it.each([
    ['no cover', (m: number[]) => [{ mediaId: m[0], isCover: false }], 400],
    ['two covers', (m: number[]) => [{ mediaId: m[0], isCover: true }, { mediaId: m[1], isCover: true }], 400],
    ['the same image twice', (m: number[]) => [{ mediaId: m[0], isCover: true }, { mediaId: m[0], isCover: false }], 400],
    ['21 images', (m: number[]) => Array.from({ length: 21 }, (_, i) => ({ mediaId: m[0]! + i, isCover: i === 0 })), 400],
    ['an alt text over 200 characters', (m: number[]) => [{ mediaId: m[0], isCover: true, alt: 'a'.repeat(201) }], 400],
  ])('%s → %i', async (_l, images, status) => {
    const p = await create();
    expect((await call('put', `/products/${p.id}/images`, ADMIN, { images: images([await media(), await media()]) })).status).toBe(status);
  });

  it.each([
    ['a failed image', { status: 'FAILED' }], ['a rejected image', { status: 'REJECTED' }], ['a never-uploaded presign', { status: 'PENDING_UPLOAD' }],
    ['a private upload', { visibility: 'PRIVATE' }], ['a catalogue-import file', { scope: 'import' }], ['a video', { kind: 'VIDEO' }],
  ])('%s → 422 MEDIA_NOT_USABLE', async (_l, o) => {
    const p = await create();
    const bad = await media(o);
    const res = await call('put', `/products/${p.id}/images`, ADMIN, { images: [{ mediaId: bad, isCover: true }] });
    expect([res.status, res.body.error.code, res.body.error.details]).toEqual([422, 'MEDIA_NOT_USABLE', { mediaIds: [bad] }]);
  });

  it('a live product cannot lose its ready cover (409 UNPUBLISH_FIRST); STAFF → 403; unknown product → 404', async () => {
    const p = await create({ categoryId, description: '<p>Teak frame</p>', variants: [{ size: '4x6', weightG: 300, weightSource: 'MEASURED' }] });
    const v = p.variants[0]!.id;
    await prisma.$executeRawUnsafe(`UPDATE product_variants SET price = 21000 WHERE id = $1`, v);
    await prisma.$transaction((tx) => fn.adjustOnHand(tx, { rows: [{ variantId: v, kind: 'RECOUNT', quantity: 20 }], actorId: null }));
    await call('post', `/products/${p.id}/tax-approval`, ADMIN, { hsnCode: '4414', gstRate: 5 });
    const cover = await media();
    await call('put', `/products/${p.id}/images`, ADMIN, { images: [{ mediaId: cover, isCover: true }] });
    expect((await call('post', `/products/${p.id}/publish`, ADMIN, {})).status).toBe(200);
    const res = await call('put', `/products/${p.id}/images`, ADMIN, { images: [{ mediaId: await media({ status: 'PROCESSING' }), isCover: true }] });
    expect([res.status, res.body.error.code]).toEqual([409, 'UNPUBLISH_FIRST']);
    expect((await prisma.productImage.findFirstOrThrow({ where: { productId: p.id } })).mediaId).toBe(cover);
    expect((await call('put', `/products/${p.id}/images`, STAFF, { images: [] })).status).toBe(403);
    expect((await call('put', '/products/999999/images', ADMIN, { images: [] })).status).toBe(404);
  });
});

describe('editor payload and lists', () => {
  it('says who changed the product last (for "changed by Anu at 10:42")', async () => {
    const p = await create();
    const res = await call('get', `/products/${p.id}`);
    expect(res.body.updatedBy).toEqual({ id: ADMIN.id, name: 'Anu', email: expect.stringContaining('@artq.in') });
    expect(typeof res.body.updatedAt).toBe('string');
  });

  it('a version conflict carries the current product including who changed it', async () => {
    const p = await create();
    await call('patch', `/products/${p.id}`, ADMIN, { version: p.version, name: 'First' });
    const res = await call('patch', `/products/${p.id}`, ADMIN, { version: p.version, name: 'Second' });
    expect(res.body.error.details.current).toMatchObject({ name: 'First', updatedBy: { name: 'Anu' } });
  });

  it('images, tax approval and publishing do not bump the content version: a content save afterwards is not a false conflict', async () => {
    const p = await create();
    await call('put', `/products/${p.id}/images`, ADMIN, { images: [{ mediaId: await media(), isCover: true }] });
    await call('post', `/products/${p.id}/tax-approval`, ADMIN, { hsnCode: '4414', gstRate: 5 });
    await call('post', `/products/${p.id}/archive`, ADMIN, {});
    const res = await call('patch', `/products/${p.id}`, ADMIN, { version: p.version, name: 'Still my version' });
    expect([res.status, res.body.version]).toEqual([200, p.version + 1]);
  });

  it('techniques in sort order (catalog:read)', async () => {
    const res = await call('get', '/techniques', STAFF);
    expect(res.body.data.map((t: { name: string }) => t.name)).toEqual(['Flower Preservation', 'Photo Framing', 'Resin Art']);
  });

  it('every successful mutation recorded an audit entry', () => { expect(missingAudit).toEqual([]); });
});
