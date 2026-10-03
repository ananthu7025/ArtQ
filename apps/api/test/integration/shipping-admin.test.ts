// Task 4.4: Shipping Rates admin on real PostgreSQL + Redis, seeded with the launch zones and states (product.md §8.2):
// zones and slabs, state → zone mapping, the SHIPPING setting (incl. D-7 air-only areas), per-pincode rules and the
// CSV import (all or nothing), and the preview calculator through the one shipping algorithm.
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
import type { AppCache } from '../../src/lib/app-cache.js';
import { hashPassword } from '../../src/lib/password.js';
import type { RateLimiter } from '../../src/middleware/rateLimit.js';
import { seedGeo, seedSettings, seedShipping } from '../../src/seed/steps.js';
import { registerShippingRoutes } from '../../src/shipping/admin-routes.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { catalog, order, tx, uniq } from '../helpers/fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const ORIGIN = 'http://localhost:5173';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const NO_LIMIT: RateLimiter = { hit: async () => ({ count: 0, resetMs: 60_000 }) };
const invalidated: string[] = [];
const spyCache: AppCache = { get: (_n, load) => load(), invalidate: async (n) => { invalidated.push(n); } } as AppCache;

let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express;
const missingAudit: string[] = [];
let ADMIN: { token: string }, STAFF: { token: string };

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  await seedShipping(prisma); await seedGeo(prisma); await seedSettings(prisma);
  const kerala = await prisma.state.findFirstOrThrow({ where: { name: 'Kerala' } });
  const an = await prisma.state.findFirstOrThrow({ where: { name: 'Andaman and Nicobar Islands' } });
  const delhi = await prisma.state.findFirstOrThrow({ where: { name: 'Delhi' } });
  await prisma.postalCode.createMany({ data: [
    { pincode: '682011', officeName: 'ERNAKULAM H.O', district: 'ERNAKULAM', stateId: kerala.id },
    { pincode: '744101', officeName: 'PORT BLAIR H.O', district: 'SOUTH ANDAMAN', stateId: an.id },
    { pincode: '110001', officeName: 'NEW DELHI G.P.O', district: 'NEW DELHI', stateId: delhi.id },
  ] });
  const cache = new RedisSessionCache(redis);
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: 'http://localhost:3000', adminUrl: ORIGIN });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log: pino({ level: 'silent' }), hasRecentStepUp: (sid) => service.hasRecentStepUp(sid), onMissingAudit: (req) => missingAudit.push(`${req.method} ${req.originalUrl}`) });
  registerShippingRoutes(admin, prisma, spyCache);
  app = createApp({ version: 't', origins: { storefront: ['http://localhost:3000'], admin: [ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} }, routes: [adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }), admin.router] });
  [ADMIN, STAFF] = [await login('ADMIN'), await login('STAFF')];
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });

async function login(role: UserRole) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  await prisma.user.create({ data: { email, name: role, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword('shipping-password-1') } });
  return { token: (await request(app).post('/v1/admin/auth/login').set('Origin', ORIGIN).send({ email, password: 'shipping-password-1' })).body.accessToken as string };
}
const call = (method: 'get' | 'post' | 'put' | 'delete', path: string, body?: object, who: { token: string } | null = ADMIN) => {
  let r = request(app)[method](`/v1/admin${path}`).set('Origin', ORIGIN);
  if (who) r = r.set('Authorization', `Bearer ${who.token}`);
  return body ? r.send(body) : r;
};
const fields = (res: request.Response) => Object.fromEntries((res.body.error?.details ?? []).map((d: { path: string; message: string }) => [d.path, d.message]));
const zoneNamed = async (name: string) => ((await call('get', '/shipping')).body.zones as { id: number; name: string; states: { name: string }[] }[]).find((z) => z.name === name)!;
const preview = (o: object) => call('post', '/shipping/preview', { pincode: '682011', weightG: 400, subtotal: 50_000, ...o });

describe('access and overview', () => {
  it('shipping:write only (STAFF 403, no token 401); the overview has the seeded zones, slabs, states and settings', async () => {
    expect((await call('get', '/shipping', undefined, STAFF)).status).toBe(403);
    expect((await call('get', '/shipping', undefined, null)).status).toBe(401);
    const res = await call('get', '/shipping');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body.zones.map((z: { name: string }) => z.name)).toEqual(['Kerala', 'Rest of South', 'Rest of India', 'NE / J&K / islands']);
    expect(res.body.zones[0]).toMatchObject({ extraPerKg: 4000, slabs: [{ maxWeightG: 500, rate: 5000 }, { maxWeightG: 1000, rate: 7000 }, { maxWeightG: 2000, rate: 11_000 }, { maxWeightG: 5000, rate: 22_000 }], states: [{ name: 'Kerala' }] });
    expect(res.body.states).toHaveLength(36);
    expect(res.body.settings).toMatchObject({ freeThreshold: 100_000, heavyCapG: 10_000, airOnlyPincodePrefixes: ['744', '68255'] });
  });
});

describe('preview (the one shipping algorithm, seeded rates)', () => {
  it('Kerala: 400 g + 150 g packaging = 550 g → the 1 kg slab ₹70; ₹500 order → pays it, ₹500 more for free', async () => {
    expect((await preview({})).body).toMatchObject({ place: { district: 'ERNAKULAM', state: 'Kerala' }, zone: { name: 'Kerala' }, surfaceAvailable: true,
      serviceability: { serviceable: true, codAvailable: true, fromRule: false },
      quote: { ok: true, actualWeightG: 550, chargeableWeightG: 550, rate: 7000, shipping: 7000, freeShippingApplied: false, remainingForFree: 50_000 } });
  });
  it('free from ₹1,000 after the coupon (exactly at the threshold), heavy orders pay the zone extra per kg beyond 10 kg', async () => {
    expect((await preview({ subtotal: 100_000 })).body.quote).toMatchObject({ shipping: 0, freeShippingApplied: true });
    expect((await preview({ subtotal: 100_000, couponDiscount: 1 })).body.quote).toMatchObject({ shipping: 7000, remainingForFree: 1 });
    expect((await preview({ subtotal: 10_000, freeShippingCoupon: true })).body.quote).toMatchObject({ shipping: 0 });
    expect((await preview({ subtotal: 100_000, weightG: 12_000 })).body.quote).toMatchObject({ chargeableWeightG: 12_150, shipping: 12_000, heavySurcharge: 12_000 });   // 3 kg × ₹40
  });
  it('volumetric weight wins for a big light box; BULKY needs dimensions', async () => {
    expect((await preview({ weightG: 1000, dimsCm: { length: 40, width: 30, height: 20 } })).body.quote).toMatchObject({ actualWeightG: 1150, chargeableWeightG: 4950 });
    expect((await preview({ shippingClass: 'BULKY' })).body.quote).toEqual({ ok: false, error: 'DIMENSIONS_REQUIRED' });
  });
  it('air-only area (D-7): resin (surface only) cannot go; other items can; an unknown pincode says so', async () => {
    expect((await preview({ pincode: '744101', shippingClass: 'SURFACE_ONLY' })).body).toMatchObject({ surfaceAvailable: false, zone: { name: 'NE / J&K / islands' }, quote: { ok: false, error: 'SHIPPING_RESTRICTED' } });
    expect((await preview({ pincode: '744101' })).body.quote).toMatchObject({ ok: true, rate: 14_000 });
    expect((await preview({ pincode: '999999' })).body.quote).toEqual({ ok: false, error: 'UNKNOWN_PINCODE' });
    const bad = await call('post', '/shipping/preview', { pincode: '12', weightG: 0, subtotal: -1 });
    expect(fields(bad)).toMatchObject({ pincode: 'Enter a 6-digit pincode', weightG: 'Use at least 1 g', subtotal: 'Use 0 or more' });
  });
});

describe('zones', () => {
  it('edit replaces the slabs (lightest first); the preview uses the new rates; audited', async () => {
    const z = await zoneNamed('Kerala');
    const res = await call('put', `/shipping/zones/${z.id}`, { name: 'Kerala', extraPerKg: 3000, slabs: [{ maxWeightG: 1000, rate: 6000 }, { maxWeightG: 5000, rate: 20_000 }] });
    expect(res.status).toBe(200);
    expect(res.body.zones.find((x: { id: number }) => x.id === z.id)).toMatchObject({ extraPerKg: 3000, slabs: [{ maxWeightG: 1000, rate: 6000 }, { maxWeightG: 5000, rate: 20_000 }] });
    expect((await preview({})).body.quote).toMatchObject({ rate: 6000 });
    expect(await prisma.auditLog.count({ where: { action: 'shipping.zone.update', entityId: String(z.id) } })).toBe(1);
  });
  it('validation on its field: no slabs, out of order, heavier but cheaper, name 80/81; unknown zone 404', async () => {
    const z = await zoneNamed('Rest of India');
    const put = (o: object) => call('put', `/shipping/zones/${z.id}`, { name: 'Rest of India', extraPerKg: 5500, slabs: [{ maxWeightG: 500, rate: 7000 }], ...o });
    expect(fields(await put({ slabs: [] }))).toEqual({ slabs: 'Add at least one weight slab' });
    expect(fields(await put({ slabs: [{ maxWeightG: 1000, rate: 7000 }, { maxWeightG: 1000, rate: 9000 }] }))).toEqual({ 'slabs.1.maxWeightG': 'Must be heavier than the slab above' });
    expect(fields(await put({ slabs: [{ maxWeightG: 500, rate: 7000 }, { maxWeightG: 1000, rate: 6999 }] }))).toEqual({ 'slabs.1.rate': 'A heavier slab cannot cost less' });
    expect((await put({ name: 'x'.repeat(80) })).status).toBe(200);
    expect(fields(await put({ name: 'x'.repeat(81) }))).toEqual({ name: 'Use at most 80 characters' });
    await put({ name: 'Rest of India', slabs: [{ maxWeightG: 5000, rate: 30_000 }] });
    expect(fields(await put({ extraPerKg: 1_000_001 }))).toEqual({ extraPerKg: 'At most ₹10,000' });
    expect((await call('put', '/shipping/zones/999999', { name: 'x', extraPerKg: 1, slabs: [{ maxWeightG: 1, rate: 1 }] })).status).toBe(404);
  });
  it('create; delete only an empty unused zone (states or orders → 409, turn it off instead)', async () => {
    const created = await call('post', '/shipping/zones', { name: 'Express metro', extraPerKg: 6000, slabs: [{ maxWeightG: 2000, rate: 15_000 }] });
    expect(created.status).toBe(201);
    const id = created.body.zones.find((z: { name: string }) => z.name === 'Express metro').id;
    const withStates = await zoneNamed('Rest of South');
    expect((await call('delete', `/shipping/zones/${withStates.id}`)).body.error).toMatchObject({ code: 'ZONE_IN_USE', details: { reason: 'STATES' } });
    const cat = await catalog(prisma, [[{ price: 1000 }]]);
    const o = await tx(prisma, (t) => order(t, { lines: [{ variantId: cat.products[0]!.variantIds[0]!, qty: 1 }], reserve: false }));
    await prisma.order.update({ where: { id: o.orderId }, data: { shippingZoneId: id } });
    expect((await call('delete', `/shipping/zones/${id}`)).body.error).toMatchObject({ code: 'ZONE_IN_USE', details: { reason: 'ORDERS' } });
    expect((await call('get', '/shipping')).body.zones.find((z: { id: number }) => z.id === id).usedByOrders).toBe(true);
    const spare = (await call('post', '/shipping/zones', { name: 'Spare', extraPerKg: 0, slabs: [{ maxWeightG: 1, rate: 0 }] })).body.zones.find((z: { name: string }) => z.name === 'Spare').id;
    expect((await call('delete', `/shipping/zones/${spare}`)).status).toBe(200);
    expect((await call('delete', `/shipping/zones/${spare}`)).status).toBe(404);
  });
  it('an inactive zone has no rate: its pincodes cannot be quoted until it is on again', async () => {
    const z = await zoneNamed('Rest of India');
    await call('put', `/shipping/zones/${z.id}`, { name: 'Rest of India', extraPerKg: 5500, isActive: false, slabs: [{ maxWeightG: 5000, rate: 30_000 }] });
    expect((await preview({ pincode: '110001' })).body).toMatchObject({ zone: null, quote: { ok: false, error: 'NO_ZONE' } });
    await call('put', `/shipping/zones/${z.id}`, { name: 'Rest of India', extraPerKg: 5500, isActive: true, slabs: [{ maxWeightG: 5000, rate: 30_000 }] });
    expect((await preview({ pincode: '110001' })).body.quote).toMatchObject({ ok: true, rate: 30_000 });
  });
});

describe('state → zone mapping', () => {
  it('moves a state; null = no delivery rate there; unknown zone or duplicate state refused', async () => {
    const states = (await call('get', '/shipping')).body.states as { id: number; name: string; zoneId: number }[];
    const kerala = states.find((s) => s.name === 'Kerala')!;
    const south = await zoneNamed('Rest of South');
    const res = await call('put', '/shipping/state-zones', { assignments: [{ stateId: kerala.id, zoneId: south.id }] });
    expect(res.body.states.find((s: { id: number }) => s.id === kerala.id).zoneId).toBe(south.id);
    expect((await preview({})).body.zone).toEqual({ id: south.id, name: 'Rest of South' });
    await call('put', '/shipping/state-zones', { assignments: [{ stateId: kerala.id, zoneId: null }] });
    expect((await preview({})).body.quote).toEqual({ ok: false, error: 'NO_ZONE' });
    await call('put', '/shipping/state-zones', { assignments: [{ stateId: kerala.id, zoneId: kerala.zoneId }] });
    expect((await call('put', '/shipping/state-zones', { assignments: [{ stateId: kerala.id, zoneId: 999_999 }] })).status).toBe(422);
    expect((await call('put', '/shipping/state-zones', { assignments: [{ stateId: kerala.id, zoneId: null }, { stateId: kerala.id, zoneId: null }] })).status).toBe(400);
    expect(missingAudit).toEqual([]);
  });
});

describe('SHIPPING setting', () => {
  it('saves (the storefront cache is dropped); the new threshold and air-only list apply at once', async () => {
    const s = (await call('get', '/shipping')).body.settings;
    invalidated.length = 0;
    const res = await call('put', '/shipping/settings', { ...s, freeThreshold: 150_000, airOnlyPincodePrefixes: ['744', '68255', '7371'] });
    expect(res.status).toBe(200);
    expect(invalidated).toEqual(['publicSettings']);
    expect((await preview({ subtotal: 100_000 })).body.quote).toMatchObject({ freeShippingApplied: false, remainingForFree: 50_000 });
    await call('put', '/shipping/settings', s);
  });
  it('validation on its field, the same schema as the form', async () => {
    const s = (await call('get', '/shipping')).body.settings;
    expect(fields(await call('put', '/shipping/settings', { ...s, estimatedDays: { min: 5, max: 4 } }))).toEqual({ 'estimatedDays.max': 'Use at least the minimum' });
    expect(fields(await call('put', '/shipping/settings', { ...s, airOnlyPincodePrefixes: ['abc'] }))).toEqual({ 'airOnlyPincodePrefixes.0': 'Use 2 to 6 digits of a pincode, e.g. 744' });
    expect(fields(await call('put', '/shipping/settings', { ...s, airOnlyPincodePrefixes: ['744', '744'] }))).toEqual({ airOnlyPincodePrefixes: 'Each prefix only once' });
    expect(fields(await call('put', '/shipping/settings', { ...s, packagingWeightG: 5001 }))).toEqual({ packagingWeightG: 'At most 5,000 g' });
    expect((await call('put', '/shipping/settings', { ...s, packagingWeightG: 5000 })).status).toBe(200);
    expect((await call('put', '/shipping/settings', { ...s, extra: 1 })).status).toBe(400);
    await call('put', '/shipping/settings', s);
  });
});

describe('pincode rules', () => {
  it('a rule overrides the default policy; list with filters and pincode search; removing it restores the default', async () => {
    const put = await call('put', '/shipping/pincodes/682011', { isServiceable: true, codAvailable: false, eddMinDays: 2, eddMaxDays: 3, note: 'Prepaid only for now' });
    expect(put.body).toMatchObject({ pincode: '682011', place: { district: 'ERNAKULAM', state: 'Kerala' }, codAvailable: false, eddMinDays: 2, source: 'MANUAL' });
    expect((await preview({})).body.serviceability).toEqual({ serviceable: true, codAvailable: false, fromRule: true });
    await call('put', '/shipping/pincodes/110001', { isServiceable: false, codAvailable: false });
    expect((await preview({ pincode: '110001' })).body.quote).toEqual({ ok: false, error: 'PINCODE_NOT_SERVICEABLE' });
    const list = async (q: string) => ((await call('get', `/shipping/pincodes${q}`)).body.data as { pincode: string }[]).map((r) => r.pincode);
    expect(await list('?filter=blocked')).toEqual(['110001']);
    expect(await list('?filter=no_cod')).toEqual(['682011']);
    expect(await list('?filter=custom_days')).toEqual(['682011']);
    expect(await list('?q=68')).toEqual(['682011']);
    expect((await call('get', '/shipping/pincodes?q=abc')).status).toBe(400);
    expect((await call('delete', '/shipping/pincodes/682011')).status).toBe(200);
    expect((await call('delete', '/shipping/pincodes/682011')).status).toBe(404);
    expect((await preview({})).body.serviceability.fromRule).toBe(false);
    await call('delete', '/shipping/pincodes/110001');
  });
  it('validation: COD needs delivery, both days or neither, max ≥ min, note 200/201, a real pincode', async () => {
    const put = (o: object, pin = '682011') => call('put', `/shipping/pincodes/${pin}`, { isServiceable: true, codAvailable: true, ...o });
    expect(fields(await put({ isServiceable: false }))).toEqual({ codAvailable: 'Cash on delivery needs delivery to this pincode' });
    expect(fields(await put({ eddMinDays: 2 }))).toEqual({ eddMaxDays: 'Enter both days, or neither (the default applies)' });
    expect(fields(await put({ eddMinDays: 5, eddMaxDays: 4 }))).toEqual({ eddMaxDays: 'Use at least the minimum' });
    expect((await put({ note: 'x'.repeat(200) })).status).toBe(200);
    expect(fields(await put({ note: 'x'.repeat(201) }))).toEqual({ note: 'Use at most 200 characters' });
    expect((await put({}, '012345')).status).toBe(400);
    await call('delete', '/shipping/pincodes/682011');
  });
});

describe('pincode CSV import (all rows or none)', () => {
  const header = 'pincode,deliverable,cod,edd_min_days,edd_max_days,note';
  const imp = (csv: string, dryRun = false) => call('post', '/shipping/pincodes/import', { csv, dryRun });
  it('a file with mistakes saves nothing and lists each problem with its line', async () => {
    const res = await imp([header, '560001,yes,yes,,,', '12,yes,no,,,', '560002,maybe,no,,,', '560001,no,no,,,', '560003,no,yes,,,', '560004,yes,yes,3,,'].join('\n'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rows: 6, saved: false });
    expect(res.body.errors).toEqual([
      { line: 3, message: '“12” is not a 6-digit pincode' },
      { line: 4, message: 'deliverable must be yes or no' },
      { line: 5, message: '560001 is already on line 2' },
      { line: 6, message: 'codAvailable: Cash on delivery needs delivery to this pincode' },
      { line: 7, message: 'eddMaxDays: Enter both days, or neither (the default applies)' },
    ]);
    expect(await prisma.pincodeServiceability.count({ where: { pincode: { startsWith: '5600' } } })).toBe(0);
    expect((await imp('pin,ok\n560001,yes')).body.errors[0].message).toMatch(/^The first row must name the columns/);
  });
  it('dry run counts; saving creates and updates; the same file again changes nothing; BOM, quotes and CRLF are fine', async () => {
    await call('put', '/shipping/pincodes/560010', { isServiceable: true, codAvailable: true });
    const csv = '﻿' + [header, '560010,yes,no,2,4,"Bengaluru, central"', '560011,No,No,,,', '560012,Y,Y,,,'].join('\r\n');
    expect((await imp(csv, true)).body).toEqual({ rows: 3, created: 2, updated: 1, unchanged: 0, errors: [], saved: false });
    expect(await prisma.pincodeServiceability.count({ where: { pincode: { in: ['560011', '560012'] } } })).toBe(0);
    expect((await imp(csv)).body).toEqual({ rows: 3, created: 2, updated: 1, unchanged: 0, errors: [], saved: true });
    expect(await prisma.pincodeServiceability.findUniqueOrThrow({ where: { pincode: '560010' } })).toMatchObject({ isServiceable: true, codAvailable: false, eddMinDays: 2, eddMaxDays: 4, note: 'Bengaluru, central', source: 'CSV' });
    expect((await imp(csv)).body).toMatchObject({ created: 0, updated: 0, unchanged: 3, saved: true });
    expect(await prisma.auditLog.count({ where: { action: 'shipping.pincode.import' } })).toBe(2);
  });
  it('2,500 rows in one go; more than 20,000 rows refused', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => `${400001 + i},yes,yes,,,`);
    expect((await imp([header, ...rows].join('\n'))).body).toMatchObject({ rows: 2500, created: 2500, saved: true });
    const big = [header, ...Array.from({ length: 20_001 }, (_, i) => `${300001 + i},yes,yes,,,`)].join('\n');
    expect((await imp(big)).body.errors).toEqual([{ line: 1, message: 'At most 20,000 rows per file' }]);
    expect(fields(await call('post', '/shipping/pincodes/import', { csv: '' }))).toEqual({ csv: 'The file is empty' });
  });
});
