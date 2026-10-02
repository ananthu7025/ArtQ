// Task 2.8: inventory (on-hand only) on real PostgreSQL + Redis.
// ✅ AT-13: an inventory import sets on_hand while 3 orders hold reservations → reserved unchanged, available
//    recalculated, a count below reserved raises OVERSOLD; a catalogue re-import changes no stock.
// ✅ AT-10 re-run against the real inventory endpoints: price fields → 400; STAFF can count, never price.
import type { PrismaClient, UserRole } from '@prisma/client';
import ExcelJS from 'exceljs';
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
import * as fn from '../../src/db/functions.js';
import { registerImportRoutes } from '../../src/imports/routes.js';
import { ImportService } from '../../src/imports/service.js';
import { registerInventoryRoutes } from '../../src/inventory/routes.js';
import { hashPassword } from '../../src/lib/password.js';
import type { RateLimiter } from '../../src/middleware/rateLimit.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { catalog, order, uniq, val } from '../helpers/fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const ADMIN_ORIGIN = 'http://localhost:5173';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const PASSWORD = 'inventory-password-123';
const NO_LIMIT: RateLimiter = { hit: async () => ({ count: 0, resetMs: 60_000 }) };

let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express, imports: ImportService;
const files = new Map<number, Buffer>();
const missingAudit: string[] = [];
let ADMIN: { id: number; token: string }, STAFF: { id: number; token: string };

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  const cache = new RedisSessionCache(redis);
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: 'http://localhost:3000', adminUrl: ADMIN_ORIGIN });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log: pino({ level: 'silent' }), hasRecentStepUp: (sid) => service.hasRecentStepUp(sid), onMissingAudit: (req) => missingAudit.push(`${req.method} ${req.originalUrl}`) });
  imports = new ImportService({ prisma, readFile: async (m) => files.get(m.id)!, enqueue: { validate: async () => {}, apply: async () => {} } });
  registerInventoryRoutes(admin, prisma);
  registerImportRoutes(admin, prisma, imports);
  app = createApp({
    version: 't', origins: { storefront: ['http://localhost:3000'], admin: [ADMIN_ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }), admin.router],
  });
  [ADMIN, STAFF] = [await login('ADMIN', 'Asha'), await login('STAFF', 'Sanju')];
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });

async function login(role: UserRole, name: string) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  const u = await prisma.user.create({ data: { email, name, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword(PASSWORD) } });
  const res = await request(app).post('/v1/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email, password: PASSWORD });
  return { id: u.id, token: res.body.accessToken as string };
}
type Method = 'get' | 'post';
const call = (method: Method, path: string, who: { token: string } | null = ADMIN, body?: object) => {
  let r = request(app)[method](`/v1/admin${path}`).set('Origin', ADMIN_ORIGIN);
  if (who) r = r.set('Authorization', `Bearer ${who.token}`);
  return body ? r.send(body) : r;
};
const adjust = (rows: object[], who = ADMIN) => call('post', '/inventory/adjustments', who, { rows });
const variant = (id: number) => prisma.productVariant.findUniqueOrThrow({ where: { id } });
async function variants(n: number, onHand = 10) {
  const cat = await catalog(prisma, [Array.from({ length: n }, () => ({ price: 10_000, onHand }))]);
  return { productId: cat.products[0]!.productId, ids: cat.products[0]!.variantIds };
}
async function countFile(rows: (string | number | null)[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Stock count');
  ws.addRow(['SKU', 'Product', 'Variant', 'On hand (system)', 'Counted quantity', 'Change (+/−)', 'Note']);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function upload(buffer: Buffer, who = ADMIN) {
  const id = await val<number>(prisma, `INSERT INTO media (key, visibility, kind, declared_mime, declared_size, owner_scope, status, uploaded_by, updated_at)
    VALUES ($1,'PRIVATE','DOCUMENT','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',$2,'import','READY',$3,now()) RETURNING id`, `private/catalog-import/${uniq()}.xlsx`, buffer.length, who.id);
  files.set(id, buffer);
  return id;
}
async function runImport(kind: 'CATALOG' | 'INVENTORY', buffer: Buffer, who = ADMIN) {
  const res = await call('post', '/imports', who, { kind, fileMediaId: await upload(buffer, who), createMissing: true });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(await imports.validate(res.body.id, true)).toBe('VALIDATED');
  expect((await call('post', `/imports/${res.body.id}/confirm`, who, {})).status).toBe(200);
  expect(await imports.apply(res.body.id)).toBe('DONE');
  return res.body.id as number;
}

describe('✅ AT-13: imports during reservations', () => {
  it('an inventory import sets on_hand while 3 orders hold reservations; reserved untouched; count < reserved ⇒ OVERSOLD; catalogue re-import changes no stock', async () => {
    const { ids: [a, b] } = await variants(2, 10);
    // 3 open orders reserve 2 units of A each, and 1 unit of B each.
    for (let i = 0; i < 3; i++) await prisma.$transaction((tx) => order(tx, { lines: [{ variantId: a!, qty: 2 }, { variantId: b!, qty: 1 }] }));
    expect(await variant(a!)).toMatchObject({ onHand: 10, reserved: 6 });
    const [skuA, skuB] = [(await variant(a!)).sku, (await variant(b!)).sku];

    const id = await runImport('INVENTORY', await countFile([[skuA, null, null, 10, 8, null, null], [skuB, null, null, 10, 1, null, null]]));
    const [va, vb] = [await variant(a!), await variant(b!)];
    expect(va).toMatchObject({ onHand: 8, reserved: 6 });                // reserved unchanged; available 2
    expect(vb).toMatchObject({ onHand: 1, reserved: 3 });                // counted below what is reserved
    expect(va.inventoryCountedAt).not.toBeNull();
    const product = await prisma.product.findUniqueOrThrow({ where: { id: va.productId } });
    expect(product.availableQty).toBe(2);                                 // max(8−6,0) + max(1−3,0)
    expect(await prisma.paymentException.count({ where: { type: 'OVERSOLD', dedupeKey: { startsWith: `OVERSOLD:${b}:` } } })).toBe(1);
    expect(await prisma.inventoryMovement.count({ where: { importId: id, reason: 'RECOUNT' } })).toBe(2);
    const rowB = await prisma.productImportRow.findFirstOrThrow({ where: { importId: id, sku: skuB } });
    expect(JSON.stringify(rowB.messages)).toContain('Oversold: 3 reserved, 1 on hand');
    expect(await val(prisma, `SELECT count(*)::int FROM variant_reservation_drift`)).toBe(0);

    // A catalogue re-import with different stock numbers changes no stock.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('2. Products & Variants');
    ws.addRow(['Category (Type) *', 'Subcategory *', 'Product Name *', 'Size / Volume *', 'Selling Price (₹) *', 'Stock Quantity *', 'SKU']);
    ws.addRow(['AT13 Type', 'AT13 Cat', product.name, 's0', 100, 999, skuA]);
    ws.addRow(['AT13 Type', 'AT13 Cat', product.name, 's1', 100, 999, skuB]);
    const before = await prisma.inventoryMovement.count();
    await runImport('CATALOG', Buffer.from(await wb.xlsx.writeBuffer()));
    expect(await variant(a!)).toMatchObject({ onHand: 8, reserved: 6 });
    expect(await variant(b!)).toMatchObject({ onHand: 1, reserved: 3 });
    expect(await prisma.inventoryMovement.count()).toBe(before);
  });

  it('an inventory import running alongside checkouts: reservations stay consistent, no drift', async () => {
    const { ids } = await variants(6, 50);
    const skus = await Promise.all(ids.map(async (id) => (await variant(id)).sku));
    const res = await call('post', '/imports', ADMIN, { kind: 'INVENTORY', fileMediaId: await upload(await countFile(skus.map((s) => [s, null, null, 50, 40, null, null]))) });
    await imports.validate(res.body.id, false);
    await call('post', `/imports/${res.body.id}/confirm`, ADMIN, {});
    await Promise.all([
      imports.apply(res.body.id),
      ...ids.map((v) => prisma.$transaction((tx) => order(tx, { lines: [{ variantId: v, qty: 3 }] }), { timeout: 30_000 })),
    ]);
    for (const v of ids) expect(await variant(v)).toMatchObject({ onHand: 40, reserved: 3 });
    expect(await val(prisma, `SELECT count(*)::int FROM variant_reservation_drift`)).toBe(0);
    expect(await val(prisma, `SELECT count(*)::int FROM product_aggregate_drift`)).toBe(0);
  });
});

describe('aggregates under concurrency (migration 0005)', () => {
  it('a count and a checkout on DIFFERENT variants of one product at the same time: the product totals include both', async () => {
    const { productId, ids: [v1, v2] } = await variants(2, 10);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let holding!: () => void;
    const aHolds = new Promise<void>((r) => { holding = r; });
    // A: recount variant 1 → its refresh holds the product's lock until A commits.
    const a = prisma.$transaction(async (tx) => {
      await fn.adjustOnHand(tx, { rows: [{ variantId: v1!, kind: 'RECOUNT', quantity: 4 }], actorId: null });
      holding();
      await gate;
    }, { timeout: 30_000 });
    await aHolds;
    // B: a checkout reserves variant 2; its refresh waits for A's product lock.
    const b = prisma.$transaction((tx) => order(tx, { lines: [{ variantId: v2!, qty: 3 }] }), { timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 500));
    release();
    await Promise.all([a, b]);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).availableQty).toBe(4 + 7);
    expect(await val(prisma, `SELECT count(*)::int FROM product_aggregate_drift WHERE id = $1`, productId)).toBe(0);
  });
});

describe('inventory list', () => {
  it('on hand / reserved / available per variant; filters low, out, oversold, uncounted; search', async () => {
    const { ids: [ok, low, out, over] } = await variants(4, 10);
    await prisma.productVariant.update({ where: { id: low! }, data: { lowStockThreshold: 5 } });
    await adjust([{ variantId: ok!, kind: 'RECOUNT', quantity: 30 }, { variantId: low!, kind: 'RECOUNT', quantity: 4 }, { variantId: out!, kind: 'RECOUNT', quantity: 0 }]);
    await prisma.$transaction((tx) => order(tx, { lines: [{ variantId: over!, qty: 5 }] }));
    await adjust([{ variantId: over!, kind: 'RECOUNT', quantity: 2 }]);
    const sku = (await variant(low!)).sku;
    const one = (await call('get', `/inventory?q=${sku}`)).body.data;
    expect(one).toEqual([expect.objectContaining({ variantId: low, sku, onHand: 4, reserved: 0, available: 4, lowStockThreshold: 5, countedAt: expect.any(String) })]);
    const ids = async (stock: string) => (await call('get', `/inventory?stock=${stock}&limit=100`)).body.data.map((r: { variantId: number }) => r.variantId);
    expect(await ids('low')).toContain(low);
    expect(await ids('low')).not.toContain(ok);
    expect(await ids('out')).toEqual(expect.arrayContaining([out, over]));
    expect(await ids('oversold')).toContain(over);
    expect((await call('get', '/inventory?limit=100')).body.data[0].reserved).toBeGreaterThan((await call('get', '/inventory?limit=100')).body.data[0].onHand);   // oversold first
    const counted = await ids('uncounted');
    expect(counted).not.toContain(ok);
    expect((await call('get', '/inventory?stock=sold')).status).toBe(400);
    expect((await call('get', '/inventory', STAFF)).status).toBe(200);
    expect((await call('get', '/inventory', null)).status).toBe(401);
  });
});

describe('adjustments', () => {
  it('recount sets on hand and marks counted; adjustment adds/removes; write-off removes; all audited with the ledger', async () => {
    const { productId, ids: [v] } = await variants(1, 10);
    expect(await val<string[]>(prisma, `SELECT product_readiness_failures(p) FROM products p WHERE id = $1`, productId)).toContain('stock_uncounted');
    let res = await adjust([{ variantId: v, kind: 'RECOUNT', quantity: 12 }], STAFF);
    expect(res.body).toEqual({ data: [expect.objectContaining({ variantId: v, onHand: 12, available: 12, countedAt: expect.any(String) })], oversold: [] });
    expect(((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).readiness as { failures: string[] }).failures).not.toContain('stock_uncounted');
    res = await adjust([{ variantId: v, kind: 'ADJUSTMENT', quantity: -3, note: 'Returned to supplier' }]);
    expect(res.body.data[0].onHand).toBe(9);
    res = await adjust([{ variantId: v, kind: 'DAMAGE_WRITE_OFF', quantity: 2, note: 'Cracked bottles' }]);
    expect(res.body.data[0].onHand).toBe(7);
    const ledger = (await call('get', `/inventory/${v}/movements`, STAFF)).body;
    expect(ledger.variant).toMatchObject({ id: v, onHand: 7, available: 7 });
    expect(ledger.data.map((m: { reason: string; onHandDelta: number; onHandAfter: number; actor: string | null; note: string | null }) => [m.reason, m.onHandDelta, m.onHandAfter, m.actor, m.note])).toEqual([
      ['DAMAGE_WRITE_OFF', -2, 7, 'Asha', 'Cracked bottles'], ['ADJUSTMENT', -3, 9, 'Asha', 'Returned to supplier'], ['RECOUNT', 2, 12, 'Sanju', null],
    ]);
    const audits = await prisma.auditLog.findMany({ where: { action: 'inventory.adjust' }, orderBy: { id: 'asc' } });
    expect(audits.at(-3)).toMatchObject({ actorId: STAFF.id, before: [{ variantId: v, onHand: 10 }] });
  });

  it('a recount below what is reserved: accepted (physical truth), OVERSOLD exception, reserved untouched', async () => {
    const { ids: [v] } = await variants(1, 5);
    await prisma.$transaction((tx) => order(tx, { lines: [{ variantId: v!, qty: 4 }] }));
    const res = await adjust([{ variantId: v, kind: 'RECOUNT', quantity: 1 }]);
    expect(res.body).toMatchObject({ data: [{ onHand: 1, reserved: 4, available: -3 }], oversold: [v] });
    expect(await prisma.paymentException.count({ where: { type: 'OVERSOLD', dedupeKey: { startsWith: `OVERSOLD:${v}:` } } })).toBe(1);
  });

  it('back in stock: going from 0 available to more emits the restock event', async () => {
    const { ids: [v] } = await variants(1, 0);
    await adjust([{ variantId: v, kind: 'RECOUNT', quantity: 6 }]);
    expect(await prisma.outboxEvent.count({ where: { eventType: 'variant.back_in_stock', aggregateId: String(v) } })).toBe(1);
  });

  it('a change that would go below zero refuses the whole request (nothing changes); unknown variants → 404', async () => {
    const { ids: [x, y] } = await variants(2, 3);
    const res = await adjust([{ variantId: x, kind: 'RECOUNT', quantity: 20 }, { variantId: y, kind: 'ADJUSTMENT', quantity: -5, note: 'Lost' }]);
    expect([res.status, res.body.error.code, res.body.error.details]).toEqual([422, 'INVALID_ADJUSTMENT', { variantId: y }]);
    expect((await variant(x!)).onHand).toBe(3);
    expect((await adjust([{ variantId: 999_999, kind: 'RECOUNT', quantity: 1 }])).status).toBe(404);
  });

  it.each([
    ['a negative count', [{ kind: 'RECOUNT', quantity: -1 }], 'rows.0.quantity', 'A count cannot be negative'],
    ['a zero change', [{ kind: 'ADJUSTMENT', quantity: 0, note: 'x' }], 'rows.0.quantity', 'Enter a change other than 0 (use − to remove units)'],
    ['a write-off without a reason', [{ kind: 'DAMAGE_WRITE_OFF', quantity: 1 }], 'rows.0.note', 'Give a reason'],
    ['a fractional quantity', [{ kind: 'RECOUNT', quantity: 1.5 }], 'rows.0.quantity', 'Use whole units'],
    ['more than 100000 units', [{ kind: 'RECOUNT', quantity: 100_001 }], 'rows.0.quantity', 'At most 100000 units'],
  ])('400 for %s, with the field message', async (_l, rows, path, message) => {
    const { ids: [v] } = await variants(1);
    const res = await adjust((rows as object[]).map((r) => ({ variantId: v, ...r })));
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path, message })]));
  });

  it('boundaries: exactly 100000 is accepted; duplicate variants and 201 rows are refused', async () => {
    const { ids: [v] } = await variants(1);
    expect((await adjust([{ variantId: v, kind: 'RECOUNT', quantity: 100_000 }])).status).toBe(200);
    expect((await adjust([{ variantId: v, kind: 'RECOUNT', quantity: 1 }, { variantId: v, kind: 'RECOUNT', quantity: 2 }])).status).toBe(400);
    expect((await adjust(Array.from({ length: 201 }, (_, i) => ({ variantId: i + 1, kind: 'RECOUNT', quantity: 1 })))).status).toBe(400);
    expect((await adjust([])).status).toBe(400);
  });
});

describe('inventory import (count sheet)', () => {
  it('validates every row (unknown SKU, both filled, missing reason, negative, duplicate, below zero, blank) and applies the good ones', async () => {
    const { ids: [a, b, c] } = await variants(3, 5);
    const [sa, sb, sc] = await Promise.all([a!, b!, c!].map(async (id) => (await variant(id)).sku));
    const id = (await call('post', '/imports', STAFF, { kind: 'INVENTORY', fileMediaId: await upload(await countFile([
      [sa, null, null, 5, 7, null, null],                 // 2: count
      [sb, null, null, 5, null, -2, 'Damaged in transit'], // 3: change
      ['NOPE-1', null, null, null, 3, null, null],        // 4: unknown
      [sc, null, null, 5, 3, 1, null],                    // 5: both
      [sc, null, null, 5, null, 2, null],                 // 6: no reason
      [sc, null, null, 5, -1, null, null],                // 7: negative
      [sa, null, null, 5, 9, null, null],                 // 8: duplicate SKU
      [sc, null, null, 5, null, -9, 'Mistake'],           // 9: below zero
      [sc, null, null, 5, null, null, null],              // 10: blank → skipped
    ]), STAFF) })).body.id as number;
    await imports.validate(id, false);
    const rows = (await call('get', `/imports/${id}/rows?limit=200`, STAFF)).body.data as { rowNumber: number; status: string; messages: { code: string }[] }[];
    const codes = Object.fromEntries(rows.map((r) => [r.rowNumber, `${r.status}:${r.messages.map((m) => m.code).join('+')}`]));
    expect(codes).toEqual({
      2: 'PENDING:PLANNED', 3: 'PENDING:PLANNED', 4: 'FAILED:SKU_UNKNOWN', 5: 'FAILED:BOTH_FILLED', 6: 'FAILED:NOTE_REQUIRED',
      7: 'FAILED:NEGATIVE_COUNT', 8: 'FAILED:SKU_DUPLICATE', 9: 'FAILED:BELOW_ZERO', 10: 'SKIPPED:NOTHING_TO_DO',
    });
    expect((await call('post', `/imports/${id}/confirm`, STAFF, {})).status).toBe(200);
    await imports.apply(id);
    expect(await variant(a!)).toMatchObject({ onHand: 7, inventoryCountedAt: expect.any(Date) });
    expect((await variant(b!)).onHand).toBe(3);
    expect((await variant(c!)).onHand).toBe(5);
    expect(await prisma.productImport.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'COMPLETED_WITH_ERRORS', updatedCount: 2, failedCount: 6 });
    const result = await call('get', `/imports/${id}/result.xlsx`, STAFF).buffer(true).parse((r, cb) => { const ch: Buffer[] = []; r.on('data', (d: Buffer) => ch.push(d)); r.on('end', () => cb(null, Buffer.concat(ch))); });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(result.body as Buffer);
    expect(wb.getWorksheet('Stock count')!.getRow(2).getCell(6).value).toBe('UPDATED');
  });

  it('a stock change made after the check is respected: below zero at apply time fails that row only', async () => {
    const { ids: [a, b] } = await variants(2, 5);
    const [sa, sb] = await Promise.all([a!, b!].map(async (id) => (await variant(id)).sku));
    const id = await (async () => {
      const r = await call('post', '/imports', ADMIN, { kind: 'INVENTORY', fileMediaId: await upload(await countFile([[sa, null, null, 5, null, -4, 'Sold offline'], [sb, null, null, 5, 6, null, null]])) });
      await imports.validate(r.body.id, false);
      await call('post', `/imports/${r.body.id}/confirm`, ADMIN, {});
      return r.body.id as number;
    })();
    await adjust([{ variantId: a, kind: 'RECOUNT', quantity: 2 }]);   // someone counts 2 meanwhile
    await imports.apply(id);
    expect((await variant(a!)).onHand).toBe(2);
    expect((await variant(b!)).onHand).toBe(6);
    expect(await prisma.productImportRow.findFirstOrThrow({ where: { importId: id, sku: sa } })).toMatchObject({ status: 'FAILED' });
  });

  it('the count sheet downloads with every variant and is a valid inventory file', async () => {
    const res = await call('get', '/inventory/count-sheet.xlsx', STAFF).buffer(true).parse((r, cb) => { const ch: Buffer[] = []; r.on('data', (d: Buffer) => ch.push(d)); r.on('end', () => cb(null, Buffer.concat(ch))); });
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as Buffer);
    const ws = wb.getWorksheet('Stock count')!;
    expect((ws.getRow(1).values as string[]).slice(1)).toEqual(['SKU', 'Product', 'Variant', 'On hand (system)', 'Counted quantity', 'Change (+/−)', 'Note']);
    expect(ws.rowCount - 1).toBe(await prisma.productVariant.count({ where: { deletedAt: null } }));
  });
});

describe('✅ AT-10 re-run against the real inventory endpoints', () => {
  it('price, MRP, status or reserved fields → 400 (row or top level), for STAFF and ADMIN alike; nothing changes', async () => {
    const { ids: [v] } = await variants(1, 10);
    const before = await variant(v!);
    const attempts = [
      await adjust([{ variantId: v, kind: 'RECOUNT', quantity: 5, price: 1 }], STAFF),
      await adjust([{ variantId: v, kind: 'RECOUNT', quantity: 5, mrp: 1 }], STAFF),
      await adjust([{ variantId: v, kind: 'RECOUNT', quantity: 5, reserved: 0 }], STAFF),
      await call('post', '/inventory/adjustments', STAFF, { rows: [{ variantId: v, kind: 'RECOUNT', quantity: 5 }], price: 1 }),
      await call('post', '/inventory/adjustments', ADMIN, { rows: [{ variantId: v, kind: 'RECOUNT', quantity: 5, status: 'ACTIVE' }] }),
    ];
    expect(attempts.map((a) => a.status)).toEqual([400, 400, 400, 400, 400]);
    expect(await variant(v!)).toMatchObject({ price: before.price, onHand: 10, reserved: 0 });
    expect(await prisma.auditLog.count({ where: { actorId: STAFF.id, action: 'security.admin_rejected', after: { path: ['path'], equals: '/v1/admin/inventory/adjustments' } } })).toBe(4);
  });

  it('STAFF counts stock and imports counts, but cannot see or start a catalogue import', async () => {
    const catalogImport = await runImport('CATALOG', await (async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('2. Products & Variants');
      ws.addRow(['Category (Type) *', 'Subcategory *', 'Product Name *', 'Size / Volume *', 'Selling Price (₹) *', 'Stock Quantity *', 'SKU']);
      ws.addRow(['Staff Test', 'Staff Cat', 'Staff Test Product', '1 kg', 100, 1, `STF-${uniq()}`.toUpperCase()]);
      return Buffer.from(await wb.xlsx.writeBuffer());
    })());
    const list = (await call('get', '/imports?limit=100', STAFF)).body.data as { kind: string }[];
    expect(list.every((i) => i.kind === 'INVENTORY')).toBe(true);
    expect((await call('get', `/imports/${catalogImport}`, STAFF)).status).toBe(403);
    expect((await call('get', `/imports/${catalogImport}/rows`, STAFF)).status).toBe(403);
    expect((await call('get', `/imports/${catalogImport}/result.xlsx`, STAFF)).status).toBe(403);
    expect((await call('post', '/imports', STAFF, { kind: 'CATALOG', fileMediaId: await upload(Buffer.from('x'), STAFF) })).body.error).toMatchObject({ code: 'FORBIDDEN', details: { permission: 'imports:catalog' } });
    expect((await call('get', '/imports/template.xlsx', STAFF)).status).toBe(403);
    expect((await call('get', '/imports/template.xlsx?kind=INVENTORY', STAFF)).status).toBe(200);
  });

  it('every successful change recorded an audit entry', () => { expect(missingAudit).toEqual([]); });
});
