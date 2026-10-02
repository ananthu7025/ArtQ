// Task 1.7: permissions + audit through createAdminRouter, on real PostgreSQL + Redis.
// ✅ AT-10: STAFF attempting price changes via inventory, variant, bulk and import endpoints → all rejected (403 / 400
// unknown key), attempts audited, prices unchanged. The endpoints here are stand-ins with the shape of the Phase 2 ones;
// tasks 2.2, 2.7 and 2.8 re-run AT-10 against the real endpoints.
import { maskContact, MASKED_CONTACT_ROLES, permissionsFor, type Role } from '@artq/shared';
import type { PrismaClient, UserRole } from '@prisma/client';
import type { Express, Request } from 'express';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerAuditRoutes } from '../../src/admin/audit-routes.js';
import { createAdminRouter, recordAudit } from '../../src/admin/router.js';
import { createApp } from '../../src/app.js';
import { adminAuthRouter } from '../../src/auth/admin-routes.js';
import { authRouter } from '../../src/auth/routes.js';
import { AuthService, DEFAULT_AUTH_TIMINGS } from '../../src/auth/service.js';
import { RedisSessionCache } from '../../src/auth/session-cache.js';
import * as fn from '../../src/db/functions.js';
import { hashPassword } from '../../src/lib/password.js';
import type { RateLimiter } from '../../src/middleware/rateLimit.js';
import { validate } from '../../src/middleware/validate.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { catalog, uniq } from '../helpers/fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const WEB = 'http://localhost:3000';
const ADMIN_ORIGIN = 'http://localhost:5173';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const PASSWORD = 'staff-password-123';
const NO_LIMIT: RateLimiter = { hit: async () => ({ count: 0, resetMs: 60_000 }) };

let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, service: AuthService, app: Express;
const missingAudit: string[] = [];
let variantId: number, productId: number;

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  const cache = new RedisSessionCache(redis);
  service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: WEB, adminUrl: 'http://localhost:5173' });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log: pino({ level: 'silent' }), hasRecentStepUp: (sid) => service.hasRecentStepUp(sid), onMissingAudit: (req: Request) => missingAudit.push(`${req.method} ${req.originalUrl}`) });
  const r = admin.routes;
  const id = z.strictObject({ id: z.coerce.number().int().positive() });

  // Variant content (catalog:write): no commercial fields in the schema.
  r.patch('/test/variants/:id', admin.can('catalog:write'), validate({ params: id, body: z.strictObject({ color: z.string().optional(), isActive: z.boolean().optional() }) }), async (req, res) => {
    await prisma.$transaction(async (tx) => {
      await fn.editVariants(tx, productId, [{ variantId: req.params.id as unknown as number, ...req.body }]);
      await recordAudit(tx, req, res, { action: 'variant.update', entity: 'variant', entityId: req.params.id, after: req.body });
    });
    res.json({ ok: true });
  });
  // Pricing (pricing:write): the only place a price can change.
  r.patch('/test/variants/:id/pricing', admin.can('pricing:write'), validate({ params: id, body: z.strictObject({ price: z.number().int().positive(), mrp: z.number().int().positive().nullable().optional() }) }), async (req, res) => {
    const vid = req.params.id as unknown as number;
    await prisma.$transaction(async (tx) => {
      const before = await tx.productVariant.findUniqueOrThrow({ where: { id: vid }, select: { price: true, mrp: true } });
      await tx.productVariant.update({ where: { id: vid }, data: { price: req.body.price } });
      await fn.refreshProducts(tx, [productId]);
      await recordAudit(tx, req, res, { action: 'variant.price_update', entity: 'variant', entityId: vid, before, after: req.body });
    });
    res.json({ ok: true });
  });
  // Inventory (inventory:adjust): on_hand only; unknown keys such as price are rejected.
  r.post('/test/inventory/adjust', admin.can('inventory:adjust'), validate({ body: z.strictObject({ rows: z.array(z.strictObject({ variantId: z.number().int(), kind: z.enum(['RECOUNT', 'ADJUSTMENT', 'DAMAGE_WRITE_OFF']), quantity: z.number().int(), note: z.string().optional() })).min(1) }) }), async (req, res) => {
    await prisma.$transaction(async (tx) => {
      await fn.adjustOnHand(tx, { rows: req.body.rows, actorId: req.auth!.userId });
      await recordAudit(tx, req, res, { action: 'inventory.adjust', entity: 'variant', after: req.body });
    });
    res.json({ ok: true });
  });
  // Bulk edit (catalog:write) and catalogue import (imports:catalog; may change prices).
  r.post('/test/variants/bulk', admin.can('catalog:write'), validate({ body: z.strictObject({ variantIds: z.array(z.number().int()), isActive: z.boolean() }) }), async (req, res) => {
    await recordAudit(prisma, req, res, { action: 'variant.bulk_update', entity: 'variant', after: req.body });
    res.json({ ok: true });
  });
  r.post('/test/imports/catalog', admin.can('imports:catalog'), validate({ body: z.strictObject({ fileId: z.number().int() }) }), async (req, res) => {
    await recordAudit(prisma, req, res, { action: 'import.catalog_start', entity: 'import', after: req.body });
    res.status(202).json({ ok: true });
  });
  // Refund (refunds:create ⇒ step-up).
  r.post('/test/refunds', admin.can('refunds:create'), async (req, res) => {
    await recordAudit(prisma, req, res, { action: 'refund.create', entity: 'refund' });
    res.status(201).json({ ok: true });
  });
  // Opt-in step-up for a non-listed permission (e.g. a customer-data export).
  r.post('/test/customers/export', admin.can('customers:read', { stepUp: true }), async (req, res) => {
    await recordAudit(prisma, req, res, { action: 'customers.export', entity: 'customer' });
    res.json({ ok: true });
  });
  // Masked contact details for STAFF.
  r.get('/test/customers', admin.can('customers:read'), (req, res) => {
    const masked = MASKED_CONTACT_ROLES.includes(req.auth!.role as Role);
    const email = 'ananthu@gmail.com';
    res.json({ email: masked ? maskContact(email) : email });
  });
  // A mutation that forgets to audit.
  r.post('/test/forgot-audit', admin.can('dashboard:read'), (_req, res) => { res.json({ ok: true }); });

  registerAuditRoutes(admin, prisma);
  app = createApp({
    version: 't', origins: { storefront: [WEB], admin: [ADMIN_ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [
      authRouter({ ...deps, service, env: 'test', refreshMaxAgeS: DEFAULT_AUTH_TIMINGS.refreshIdleS, limiter: NO_LIMIT }),
      adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }),
      admin.router,
    ],
  });
  const cat = await catalog(prisma, [[{ price: 44_900, onHand: 10 }]]);
  variantId = cat.products[0]!.variantIds[0]!;
  productId = cat.products[0]!.productId;
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });

async function login(role: UserRole) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  const u = await prisma.user.create({ data: { email, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword(PASSWORD) } });
  const res = await request(app).post(role === 'CUSTOMER' ? '/v1/auth/login' : '/v1/admin/auth/login').set('Origin', role === 'CUSTOMER' ? WEB : ADMIN_ORIGIN).send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { id: u.id, token: res.body.accessToken as string };
}
const call = (method: 'get' | 'post' | 'patch', path: string, token: string | null, body?: object) => {
  let r = request(app)[method](`/v1/admin${path}`).set('Origin', ADMIN_ORIGIN);
  if (token) r = r.set('Authorization', `Bearer ${token}`);
  return body ? r.send(body) : r;
};
const price = async () => (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).price;
const rejections = (actorId: number) => prisma.auditLog.findMany({ where: { actorId, action: 'security.admin_rejected' }, orderBy: { id: 'asc' } });

describe('AT-10: STAFF cannot change prices through any endpoint', () => {
  it('pricing, variant, bulk and import endpoints → 403; price fields on inventory → 400; all audited; price unchanged', async () => {
    const staff = await login('STAFF');
    const before = await price();
    const attempts = [
      await call('patch', `/test/variants/${variantId}/pricing`, staff.token, { price: 1 }),
      await call('patch', `/test/variants/${variantId}`, staff.token, { color: 'Gold' }),
      await call('post', '/test/variants/bulk', staff.token, { variantIds: [variantId], isActive: false }),
      await call('post', '/test/imports/catalog', staff.token, { fileId: 1 }),
      await call('post', '/test/inventory/adjust', staff.token, { rows: [{ variantId, kind: 'RECOUNT', quantity: 10, price: 987_654 }] }),
      await call('post', '/test/inventory/adjust', staff.token, { rows: [{ variantId, kind: 'RECOUNT', quantity: 10 }], price: 987_654 }),
    ];
    expect(attempts.map((a) => a.status)).toEqual([403, 403, 403, 403, 400, 400]);
    expect(attempts[0]!.body.error).toEqual({ code: 'FORBIDDEN', message: 'You do not have permission to do this', details: { permission: 'pricing:write' } });
    expect(attempts[4]!.body.error.details[0]).toMatchObject({ location: 'body', path: 'rows.0' });
    expect(await price()).toBe(before);

    const logged = await rejections(staff.id);
    expect(logged.map((l) => (l.after as { code: string }).code)).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'VALIDATION_ERROR', 'VALIDATION_ERROR']);
    expect(logged[0]!.after).toMatchObject({ method: 'PATCH', path: `/v1/admin/test/variants/${variantId}/pricing`, details: { permission: 'pricing:write' } });
    expect(JSON.stringify(logged.map((l) => [l.after, l.before]))).not.toContain('987654');   // submitted values are never stored
    expect(logged.every((l) => l.sessionId !== null)).toBe(true);
  });

  it('STAFF can still do what the role allows: a stock recount (on_hand only, audited)', async () => {
    const staff = await login('STAFF');
    const before = await price();
    const res = await call('post', '/test/inventory/adjust', staff.token, { rows: [{ variantId, kind: 'RECOUNT', quantity: 7 }] });
    expect(res.status).toBe(200);
    expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).onHand).toBe(7);
    expect(await price()).toBe(before);
    expect(await prisma.auditLog.count({ where: { actorId: staff.id, action: 'inventory.adjust' } })).toBe(1);
  });

  it('ADMIN changes the price through the pricing endpoint; the audit row has before and after', async () => {
    const admin = await login('ADMIN');
    expect((await call('patch', `/test/variants/${variantId}/pricing`, admin.token, { price: 39_900 })).status).toBe(200);
    expect(await price()).toBe(39_900);
    expect(await prisma.product.findUniqueOrThrow({ where: { id: productId } })).toMatchObject({ minPrice: 39_900 });
    const row = await prisma.auditLog.findFirstOrThrow({ where: { actorId: admin.id, action: 'variant.price_update' } });
    expect(row).toMatchObject({ entity: 'variant', entityId: String(variantId), after: { price: 39_900 } });
    expect((row.before as { price: number }).price).not.toBe(39_900);
    expect((await call('post', '/test/imports/catalog', admin.token, { fileId: 1 })).status).toBe(202);
  });

  it('even ADMIN cannot smuggle a price through the content endpoint (unknown key → 400)', async () => {
    const admin = await login('ADMIN');
    const before = await price();
    expect((await call('patch', `/test/variants/${variantId}`, admin.token, { color: 'Gold', price: 1 })).status).toBe(400);
    expect(await price()).toBe(before);
  });
});

describe('roles, step-up and authentication', () => {
  it('step-up permissions: refunds need a password re-check even for ADMIN; rejections are audited', async () => {
    const admin = await login('ADMIN');
    const first = await call('post', '/test/refunds', admin.token, {});
    expect(first.status).toBe(401);
    expect(first.body.error.code).toBe('STEP_UP_REQUIRED');
    expect((await rejections(admin.id)).map((l) => (l.after as { code: string }).code)).toEqual(['STEP_UP_REQUIRED']);
    await call('post', '/auth/step-up', admin.token, { password: PASSWORD });
    expect((await call('post', '/test/refunds', admin.token, {})).status).toBe(201);
  });

  it('STAFF is refused refunds before any step-up is asked for (403, not 401)', async () => {
    const staff = await login('STAFF');
    expect((await call('post', '/test/refunds', staff.token, {})).body.error.code).toBe('FORBIDDEN');
  });

  it('opt-in step-up on an otherwise allowed permission', async () => {
    const staff = await login('STAFF');
    expect((await call('post', '/test/customers/export', staff.token, {})).body.error.code).toBe('STEP_UP_REQUIRED');
    await call('post', '/auth/step-up', staff.token, { password: PASSWORD });
    expect((await call('post', '/test/customers/export', staff.token, {})).status).toBe(200);
  });

  it('no token, a storefront token or a customer → 401 (not audited: there is no admin identity)', async () => {
    const customer = await login('CUSTOMER');
    expect((await call('patch', `/test/variants/${variantId}/pricing`, null, { price: 1 })).body.error.code).toBe('UNAUTHENTICATED');
    expect((await call('patch', `/test/variants/${variantId}/pricing`, customer.token, { price: 1 })).body.error.code).toBe('UNAUTHENTICATED');
    expect(await prisma.auditLog.count({ where: { actorId: customer.id, action: 'security.admin_rejected' } })).toBe(0);
  });

  it('a role change takes effect on the next request (demoted ADMIN can no longer price)', async () => {
    const admin = await login('ADMIN');
    expect((await call('patch', `/test/variants/${variantId}/pricing`, admin.token, { price: 40_000 })).status).toBe(200);
    await service.changeRole(admin.id, 'STAFF');
    expect((await call('patch', `/test/variants/${variantId}/pricing`, admin.token, { price: 41_000 })).status).toBe(401);
    const relogged = await request(app).post('/v1/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: (await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).email, password: PASSWORD });
    expect((await call('patch', `/test/variants/${variantId}/pricing`, relogged.body.accessToken, { price: 41_000 })).status).toBe(403);
    expect(await price()).toBe(40_000);
  });

  it('/admin/me lists the permissions of the role', async () => {
    for (const role of ['STAFF', 'ADMIN', 'SUPER_ADMIN'] as const) {
      const u = await login(role);
      expect((await call('get', '/me', u.token)).body.permissions).toEqual(permissionsFor(role));
    }
  });

  it('STAFF see masked customer contact details; ADMIN see them in full', async () => {
    expect((await call('get', '/test/customers', (await login('STAFF')).token)).body.email).toBe('a***@gmail.com');
    expect((await call('get', '/test/customers', (await login('ADMIN')).token)).body.email).toBe('ananthu@gmail.com');
  });
});

describe('audit guarantees', () => {
  it('a successful admin mutation that wrote no audit entry is reported; GETs and failures are not', async () => {
    const staff = await login('STAFF');
    missingAudit.length = 0;
    expect((await call('post', '/test/forgot-audit', staff.token, {})).status).toBe(200);
    await call('get', '/test/customers', staff.token);
    await call('post', '/test/imports/catalog', staff.token, { fileId: 1 });          // 403
    await call('post', '/test/inventory/adjust', staff.token, { rows: [{ variantId, kind: 'RECOUNT', quantity: 7 }] });   // audited
    expect(missingAudit).toEqual(['POST /v1/admin/test/forgot-audit']);
  });

  it('a mutation whose transaction fails writes neither the change nor its audit row', async () => {
    const staff = await login('STAFF');
    const res = await call('post', '/test/inventory/adjust', staff.token, { rows: [{ variantId: 999_999, kind: 'RECOUNT', quantity: 1 }] });
    expect(res.status).toBe(500);
    expect(await prisma.auditLog.count({ where: { actorId: staff.id, action: 'inventory.adjust' } })).toBe(0);
  });
});

describe('GET /admin/audit-logs (Audit Logs module)', () => {
  it('SUPER_ADMIN pages through audit entries newest first, with actor details and filters; others are refused', async () => {
    const sup = await login('SUPER_ADMIN');
    const r = await call('get', '/audit-logs?limit=2', sup.token);
    expect(r.status).toBe(200);
    expect(r.body.meta).toMatchObject({ page: 1, limit: 2 });
    expect(r.body.meta.total).toBeGreaterThanOrEqual(2);
    expect(r.body.meta.totalPages).toBe(Math.ceil(r.body.meta.total / 2));
    const [a, b] = r.body.data as { id: string; createdAt: string; actor: { email: string } | null }[];
    expect(new Date(a!.createdAt).getTime()).toBeGreaterThanOrEqual(new Date(b!.createdAt).getTime());
    expect(typeof a!.id).toBe('string');
    const own = await call('get', `/audit-logs?actorId=${sup.id}&action=admin.`, sup.token);
    expect(own.body.data.every((x: { action: string; actor: { id: number } }) => x.action.startsWith('admin.') && x.actor.id === sup.id)).toBe(true);
    const asc = await call('get', '/audit-logs?sort=createdAt&limit=1', sup.token);
    expect(new Date(asc.body.data[0].createdAt).getTime()).toBeLessThanOrEqual(new Date(a!.createdAt).getTime());
    const last = await call('get', `/audit-logs?limit=2&page=${r.body.meta.totalPages + 5}`, sup.token);
    expect(last.body.data).toEqual([]);
    for (const bad of ['limit=101', 'page=0', 'sort=id', 'foo=1']) expect((await call('get', `/audit-logs?${bad}`, sup.token)).status).toBe(400);
    expect((await call('get', '/audit-logs', (await login('ADMIN')).token)).status).toBe(403);
  });
});
