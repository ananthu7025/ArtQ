// Task 6.5 on real PostgreSQL + Redis. Settings: the view (defaults when nothing is stored, states, who changed it),
// each save merged into the stored value (fields the page does not edit kept), the password re-check, the shared
// rules (GSTIN ↔ state, one way to pay, COD min ≤ max, limits at the boundary), an unknown state on its field, audited
// before/after, the public settings follow, two saves at once, permissions. Audit Logs: filters (entity id, India
// days), record types, one entry with before/after, the CSV export (password re-check, formula-safe, audited).
import type { PrismaClient, UserRole } from '@prisma/client';
import type { Express } from 'express';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerAuditRoutes } from '../../src/admin/audit-routes.js';
import { createAdminRouter } from '../../src/admin/router.js';
import { createApp } from '../../src/app.js';
import { adminAuthRouter } from '../../src/auth/admin-routes.js';
import { AuthService, DEFAULT_AUTH_TIMINGS } from '../../src/auth/service.js';
import { RedisSessionCache } from '../../src/auth/session-cache.js';
import { RedisAppCache } from '../../src/lib/app-cache.js';
import { hashPassword } from '../../src/lib/password.js';
import { registerSettingsRoutes } from '../../src/settings/routes.js';
import { storefrontRouter } from '../../src/storefront/routes.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { uniq } from '../helpers/fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const WEB = 'http://localhost:3000';
const ORIGIN = 'http://localhost:5173';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const log = pino({ level: 'silent' });
const NO_LIMIT = { hit: async () => ({ count: 0, resetMs: 60_000 }) };
let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express;
let OWNER: { token: string; id: number }, ADMIN: { token: string; id: number }, STAFF: { token: string; id: number };
let stepUp = true;
const missingAudit: string[] = [];

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  const cache = new RedisSessionCache(redis);
  const appCache = new RedisAppCache(redis, () => {});
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: WEB, adminUrl: ORIGIN });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log, hasRecentStepUp: async () => stepUp, onMissingAudit: (req) => missingAudit.push(`${req.method} ${req.originalUrl}`) });
  registerSettingsRoutes(admin, prisma, appCache);
  registerAuditRoutes(admin, prisma);
  app = createApp({ version: 't', origins: { storefront: [WEB], admin: [ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }), storefrontRouter({ prisma, cache: appCache, mediaUrl: (k) => k }), admin.router] });
  const india = await prisma.country.create({ data: { iso2: 'IN', name: 'India', phoneCode: '+91' } });
  await prisma.state.createMany({ data: [{ countryId: india.id, name: 'Kerala', code: 'KL', gstCode: '32' }, { countryId: india.id, name: 'Karnataka', code: 'KA', gstCode: '29' }] });
  [OWNER, ADMIN, STAFF] = await Promise.all([staff('SUPER_ADMIN', 'Meera'), staff('ADMIN', 'Anu'), staff('STAFF', 'Sanju')]);
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });
beforeEach(() => { stepUp = true; missingAudit.length = 0; });

async function staff(role: UserRole, name: string) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  const u = await prisma.user.create({ data: { email, name, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword('set-password-1') } });
  return { id: u.id, token: (await request(app).post('/v1/admin/auth/login').set('Origin', ORIGIN).send({ email, password: 'set-password-1' })).body.accessToken as string };
}
const as = (who: { token: string }, method: 'get' | 'put', path: string) => request(app)[method](`/v1/admin${path}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${who.token}`);
const fields = (res: request.Response) => Object.fromEntries((res.body.error?.details ?? []).map((d: { path: string; message: string }) => [d.path, d.message]));
const store = { name: 'ArtQ', legalName: 'ArtQ Crafts LLP', gstin: '32abcde1234f1z5', address: 'MG Road, Kochi', stateCode: '32', phone: '+91 98470 12345', email: 'hello@artq.in', whatsapp: '' };
const pay = { razorpayEnabled: true, codEnabled: true, codFee: 4000, codMin: 20_000, codMax: 500_000, pendingExpiryMinutes: 30 };

describe('settings', () => {
  it('the view: defaults when nothing is stored, the states with a GST code, nobody has changed it yet', async () => {
    await prisma.setting.deleteMany({ where: { key: { in: ['STORE_INFO', 'PAYMENT', 'ORDER', 'TAX', 'NOTIFY'] } } });
    const res = await as(OWNER, 'get', '/settings');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ STORE_INFO: { name: 'ArtQ', stateCode: '32' }, PAYMENT: { codFee: 4000 }, ORDER: { returnWindowHours: 48 }, TAX: { shippingTaxRule: 'CA_DECISION' }, NOTIFY: { adminEmails: [] },
      states: [{ code: '29', name: 'Karnataka' }, { code: '32', name: 'Kerala' }], updated: { STORE_INFO: null } });
  });

  it('store info: GSTIN in capitals; the public settings follow; audited before/after; who changed it shown', async () => {
    const res = await as(OWNER, 'put', '/settings/STORE_INFO').send(store);
    expect(res.status).toBe(200);
    expect(res.body.STORE_INFO).toEqual({ ...store, gstin: '32ABCDE1234F1Z5', whatsapp: null });
    expect(res.body.updated.STORE_INFO).toEqual({ at: expect.any(String), by: 'Meera' });
    expect((await request(app).get('/v1/settings/public')).body.store).toEqual({ name: 'ArtQ', phone: '+91 98470 12345', email: 'hello@artq.in', whatsapp: null });
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'setting.update', entityId: 'STORE_INFO' }, orderBy: { id: 'desc' } });
    expect(a.after).toMatchObject({ gstin: '32ABCDE1234F1Z5' });
    expect(missingAudit).toEqual([]);
  });

  it('a save keeps the fields the page does not edit', async () => {
    await prisma.setting.update({ where: { key: 'PAYMENT' }, data: { value: { ...pay, autoRefundExcessCapture: false } } }).catch(() => prisma.setting.create({ data: { key: 'PAYMENT', value: { ...pay, autoRefundExcessCapture: false }, isPublic: true } }));
    await as(OWNER, 'put', '/settings/PAYMENT').send({ ...pay, codFee: 5000 });
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: 'PAYMENT' } })).value).toEqual({ ...pay, codFee: 5000, autoRefundExcessCapture: false });
    await as(OWNER, 'put', '/settings/ORDER').send({ returnWindowHours: 72 });
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: 'ORDER' } })).value).toMatchObject({ returnWindowHours: 72, customerCancelUntil: 'UNFULFILLED', completeAfterDays: 7 });
    await as(OWNER, 'put', '/settings/TAX').send({ shippingTaxRule: 'EXEMPT' });
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: 'TAX' } })).value).toEqual({ pricesIncludeTax: true, shippingTaxRule: 'EXEMPT', invoiceAt: 'DISPATCH' });
    const n = await as(OWNER, 'put', '/settings/NOTIFY').send({ adminEmails: ['Owner@ArtQ.in', 'ops@artq.in'] });
    expect(n.body.NOTIFY).toEqual({ adminEmails: ['Owner@ArtQ.in', 'ops@artq.in'], dailySummary: true, lowStockEmail: true });
  });

  it('refused: the shared rules on their fields, an unknown state, extra fields; limits at the boundary', async () => {
    expect(fields(await as(OWNER, 'put', '/settings/STORE_INFO').send({ ...store, gstin: '29ABCDE1234F1Z5' }))).toEqual({ gstin: 'A GSTIN starts with its state’s code (32 for the state chosen)' });
    expect(fields(await as(OWNER, 'put', '/settings/STORE_INFO').send({ ...store, gstin: '' , stateCode: '99' }))).toEqual({ stateCode: 'Choose the state' });
    expect(fields(await as(OWNER, 'put', '/settings/STORE_INFO').send({ ...store, name: '' }))).toEqual({ name: 'Enter the store name' });
    expect((await as(OWNER, 'put', '/settings/STORE_INFO').send({ ...store, legalName: 'x'.repeat(200) })).status).toBe(200);
    expect(fields(await as(OWNER, 'put', '/settings/STORE_INFO').send({ ...store, legalName: 'x'.repeat(201) }))).toEqual({ legalName: 'Use at most 200 characters' });
    expect(fields(await as(OWNER, 'put', '/settings/PAYMENT').send({ ...pay, razorpayEnabled: false, codEnabled: false }))).toEqual({ codEnabled: 'Keep at least one way to pay switched on' });
    expect(fields(await as(OWNER, 'put', '/settings/PAYMENT').send({ ...pay, codMin: 600_000 }))).toEqual({ codMax: 'Use at least the minimum' });
    expect((await as(OWNER, 'put', '/settings/PAYMENT').send({ ...pay, codFee: 100_000 })).status).toBe(200);
    expect(fields(await as(OWNER, 'put', '/settings/PAYMENT').send({ ...pay, codFee: 100_001 }))).toEqual({ codFee: 'At most ₹1,000' });
    expect((await as(OWNER, 'put', '/settings/ORDER').send({ returnWindowHours: 720 })).status).toBe(200);
    expect((await as(OWNER, 'put', '/settings/ORDER').send({ returnWindowHours: 721 })).status).toBe(400);
    expect((await as(OWNER, 'put', '/settings/ORDER').send({ returnWindowHours: 48, completeAfterDays: 3 })).status).toBe(400);   // not editable here
    expect((await as(OWNER, 'put', '/settings/NOTIFY').send({ adminEmails: Array.from({ length: 10 }, (_, i) => `a${i}@artq.in`) })).status).toBe(200);
    expect((await as(OWNER, 'put', '/settings/NOTIFY').send({ adminEmails: Array.from({ length: 11 }, (_, i) => `a${i}@artq.in`) })).status).toBe(400);
    expect(fields(await as(OWNER, 'put', '/settings/NOTIFY').send({ adminEmails: ['a@artq.in', 'A@artq.in'] }))).toEqual({ adminEmails: 'Each address only once' });
    expect((await as(OWNER, 'put', '/settings/SHIPPING').send({})).status).toBe(404);   // saved on the Shipping Rates page
  });

  it('a password re-check before saving; STAFF cannot see or save; two saves at once both land in order', async () => {
    stepUp = false;
    expect((await as(OWNER, 'put', '/settings/ORDER').send({ returnWindowHours: 24 })).body.error.code).toBe('STEP_UP_REQUIRED');
    expect((await as(OWNER, 'get', '/settings')).status).toBe(200);   // reading needs no re-check
    stepUp = true;
    for (const who of [ADMIN, STAFF]) {   // Super Admin only
      expect((await as(who, 'get', '/settings')).status).toBe(403);
      expect((await as(who, 'put', '/settings/ORDER').send({ returnWindowHours: 24 })).status).toBe(403);
    }
    const before = await prisma.auditLog.count({ where: { entityId: 'PAYMENT' } });
    const [a, b] = await Promise.all([as(OWNER, 'put', '/settings/PAYMENT').send({ ...pay, codFee: 1000 }), as(OWNER, 'put', '/settings/PAYMENT').send({ ...pay, codFee: 2000 })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const audits = await prisma.auditLog.findMany({ where: { entityId: 'PAYMENT' }, orderBy: { id: 'asc' }, skip: before });
    expect(audits).toHaveLength(2);
    expect((audits[1]!.before as { codFee: number }).codFee).toBe((audits[0]!.after as { codFee: number }).codFee);   // the second saw the first
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: 'PAYMENT' } })).value).toMatchObject({ codFee: (audits[1]!.after as { codFee: number }).codFee });
  });
});

describe('audit logs', () => {
  it('filters by record and India day; record types; one entry with before/after; 404s; STAFF 403', async () => {
    const day = (iso: string) => new Date(iso);
    const id = `e${uniq()}`.slice(0, 20);
    await prisma.auditLog.createMany({ data: [
      { action: 'test.late', entity: 'widget', entityId: id, actorId: ADMIN.id, createdAt: day('2026-03-01T18:29:00Z'), before: { a: 1 }, after: { a: 2 } },   // 23:59 India, 1 March
      { action: 'test.next', entity: 'widget', entityId: id, actorId: null, createdAt: day('2026-03-01T18:31:00Z') },                                     // 00:01 India, 2 March
    ] });
    const one = await as(OWNER, 'get', `/audit-logs?entityId=${id}&from=2026-03-01&to=2026-03-01`);
    expect(one.body.data.map((r: { action: string }) => r.action)).toEqual(['test.late']);
    expect((await as(OWNER, 'get', `/audit-logs?entityId=${id}&from=2026-03-02`)).body.data.map((r: { action: string }) => r.action)).toEqual(['test.next']);
    expect((await as(OWNER, 'get', '/audit-logs?from=2026-03-02&to=2026-03-01')).status).toBe(400);
    expect((await as(OWNER, 'get', '/audit-logs?from=2026-02-30')).status).toBe(400);
    expect((await as(OWNER, 'get', '/audit-logs/entities')).body.data).toEqual(expect.arrayContaining(['setting', 'widget']));
    const detail = await as(OWNER, 'get', `/audit-logs/${one.body.data[0].id}`);
    expect(detail.body).toMatchObject({ action: 'test.late', actor: { id: ADMIN.id, name: 'Anu' }, before: { a: 1 }, after: { a: 2 }, sessionId: null });
    expect((await as(OWNER, 'get', '/audit-logs/999999999')).status).toBe(404);
    expect((await as(OWNER, 'get', '/audit-logs/abc')).status).toBe(400);
    expect((await as(ADMIN, 'get', '/audit-logs')).status).toBe(403);
    expect((await as(STAFF, 'get', '/audit-logs')).status).toBe(403);
  });

  it('the CSV export: password re-check; filtered; formula-safe; the system shown; audited', async () => {
    const id = `x${uniq()}`.slice(0, 20);
    await prisma.auditLog.createMany({ data: [{ action: 'test.export', entity: 'widget', entityId: id, after: { note: '=HYPERLINK("x")' } }] });
    stepUp = false;
    expect((await as(OWNER, 'get', `/audit-logs/export.csv?entityId=${id}`)).body.error.code).toBe('STEP_UP_REQUIRED');
    stepUp = true;
    const res = await as(OWNER, 'get', `/audit-logs/export.csv?entityId=${id}`);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['x-export-truncated']).toBe('0');
    const lines = res.text.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toBe('"id","created_at","actor_email","actor_name","action","entity","entity_id","ip","before","after"');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"system","","test.export","widget"');
    expect(lines[1]).toContain('"{""note"":""=HYPERLINK(\\""x\\"")""}"');
    expect((await as(OWNER, 'get', '/audit-logs/export.csv?nope=1')).status).toBe(400);
    expect(await prisma.auditLog.count({ where: { action: 'audit.export', actorId: OWNER.id } })).toBe(1);
  });
});
