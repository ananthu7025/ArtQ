// Task 2.7: catalogue import on real PostgreSQL + Redis, with the client's workbook.
// ✅ Client file → 64 drafts / 98 variants with the documented flags; a crash mid-import resumes without duplicates;
// re-import changes no stock; AT-10 re-run against the real import endpoints (STAFF → 403).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { hashPassword } from '../../src/lib/password.js';
import type { RateLimiter } from '../../src/middleware/rateLimit.js';
import { API_ROOT, createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { uniq, val } from '../helpers/fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const ADMIN_ORIGIN = 'http://localhost:5173';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const PASSWORD = 'catalog-password-123';
const NO_LIMIT: RateLimiter = { hit: async () => ({ count: 0, resetMs: 60_000 }) };
export const CLIENT_FILE = readFileSync(join(API_ROOT, '..', '..', 'ArtQ_Product_Import_All_Items.xlsx'));

let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express, imports: ImportService;
const files = new Map<number, Buffer>();
const queued: { kind: 'validate' | 'apply'; id: number; createMissing?: boolean }[] = [];
const images = new Map<string, number>();
let ADMIN: { id: number; token: string }, STAFF: { id: number; token: string };

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  const cache = new RedisSessionCache(redis);
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: 'http://localhost:3000', adminUrl: ADMIN_ORIGIN });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log: pino({ level: 'silent' }), hasRecentStepUp: (sid) => service.hasRecentStepUp(sid) });
  imports = new ImportService({
    prisma, readFile: async (m) => files.get(m.id)!,
    ingestImage: async (url) => { const id = images.get(url); if (!id) throw new Error('fetch failed'); return id; },
    enqueue: { validate: async (id, createMissing) => { queued.push({ kind: 'validate', id, createMissing }); }, apply: async (id) => { queued.push({ kind: 'apply', id }); } },
  });
  registerImportRoutes(admin, prisma, imports);
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
type Method = 'get' | 'post';
const call = (method: Method, path: string, who: { token: string } | null = ADMIN, body?: object) => {
  let r = request(app)[method](`/v1/admin${path}`).set('Origin', ADMIN_ORIGIN);
  if (who) r = r.set('Authorization', `Bearer ${who.token}`);
  return body ? r.send(body) : r;
};
/** An uploaded workbook as the media pipeline leaves it (READY unless told otherwise). */
async function upload(buffer: Buffer, o: { status?: string; userId?: number; scope?: string } = {}) {
  const id = await val<number>(prisma, `INSERT INTO media (key, visibility, kind, declared_mime, declared_size, owner_scope, status, uploaded_by, updated_at)
    VALUES ($1,'PRIVATE','DOCUMENT','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',$2,$3,$4::"MediaStatus",$5,now()) RETURNING id`,
    `private/catalog-import/${uniq()}.xlsx`, buffer.length, o.scope ?? 'import', o.status ?? 'READY', o.userId ?? ADMIN.id);
  files.set(id, buffer);
  return id;
}
/** Create (HTTP) + validate (worker) an import. */
async function validated(buffer: Buffer, createMissing = true) {
  const res = await call('post', '/imports', ADMIN, { kind: 'CATALOG', fileMediaId: await upload(buffer), createMissing });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = res.body.id as number;
  expect(queued.at(-1)).toEqual({ kind: 'validate', id, createMissing });
  expect(await imports.validate(id, createMissing)).toBe('VALIDATED');
  return id;
}
async function imported(buffer: Buffer, createMissing = true) {
  const id = await validated(buffer, createMissing);
  expect((await call('post', `/imports/${id}/confirm`, ADMIN, {})).status).toBe(200);
  expect(await imports.apply(id)).toBe('DONE');
  return id;
}
const variantBySku = (sku: string) => prisma.productVariant.findFirstOrThrow({ where: { sku, deletedAt: null }, include: { product: true } });
async function workbook(rows: Record<string, unknown>[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('2. Products & Variants');
  const headers = ['Product Key', 'Category (Type) *', 'Subcategory *', 'Product Name *', 'Description *', 'Product Images', 'Size / Volume *', 'Color', 'Thickness', 'Selling Price (₹) *', 'MRP / Orig Price (₹)', 'Stock Quantity *', 'SKU', 'Parcel Weight (kg)', 'Techniques / Occasions', 'Is Active (TRUE/FALSE)', 'Flags'];
  ws.addRow(headers);
  for (const r of rows) ws.addRow(headers.map((h) => r[h] ?? null));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('✅ the client workbook (Sheet1) → 64 drafts / 98 variants with the documented flags', () => {
  let importId: number;
  it('validates: 98 rows, 64 products, preview of flagged rows; nothing in the catalogue yet', async () => {
    importId = await validated(CLIENT_FILE);
    const view = (await call('get', `/imports/${importId}`)).body;
    expect(view).toMatchObject({ status: 'VALIDATED', totalRows: 98, products: 64, rows: { PENDING: 98 } });
    expect(view.flaggedRows).toBeGreaterThan(60);
    expect(await prisma.product.count()).toBe(0);
    const flagged = (await call('get', `/imports/${importId}/rows?flagged=1&limit=200`)).body;
    expect(flagged.data.find((r: { sku: string }) => r.sku === 'RES-21-300G')).toMatchObject({ stock: '500KG', flags: expect.arrayContaining(['STOCK_AMBIGUOUS']), plan: 'create' });
  });

  it('applies: every product a DRAFT with its import key, types/categories/techniques created, stock uncounted', async () => {
    expect((await call('post', `/imports/${importId}/confirm`, ADMIN, {})).body.status).toBe('IMPORTING');
    expect(await imports.apply(importId)).toBe('DONE');
    const imp = await prisma.productImport.findUniqueOrThrow({ where: { id: importId } });
    expect(imp).toMatchObject({ status: 'COMPLETED', createdCount: 98, failedCount: 0, reviewCount: 0 });
    expect(await prisma.product.count()).toBe(64);
    expect(await prisma.productVariant.count()).toBe(98);
    expect(await prisma.product.count({ where: { status: 'DRAFT', importKey: { not: null } } })).toBe(64);
    expect(await prisma.productType.count()).toBe(8);
    expect((await prisma.productType.findMany({ orderBy: { sortOrder: 'asc' } })).map((t) => t.slug)).toEqual(['resins', 'wooden-frames', 'multiwood-frames', 'hoops', 'pigments', 'glitters', 'silica-gel', 'resin-art-essentials']);
    expect(await prisma.category.count()).toBe(17);   // catalog.md §1: 3 + 2 + 4 + 1 + 3 + 1 + 1 + 2
    expect((await prisma.technique.findMany()).map((t) => t.slug).sort()).toEqual(['deep-pour-casting', 'embroidery-hoop-art', 'flower-preservation', 'home-decor', 'jewellery-making', 'photo-framing', 'resin-art', 'table-tops-coasters']);
    expect(await prisma.productVariant.count({ where: { inventoryCountedAt: { not: null } } })).toBe(0);   // imported stock is never "counted"
    expect(await prisma.inventoryMovement.count({ where: { reason: 'IMPORT_INITIAL', importId } })).toBe(98);
    expect(await val(prisma, `SELECT count(*)::int FROM product_aggregate_drift`)).toBe(0);
    expect(await prisma.product.count({ where: { isPublishable: true } })).toBe(0);
  });

  it('the documented values and flags (catalog.md §2, §4, §6)', async () => {
    const resin = await variantBySku('RES-21-300G');
    expect(resin).toMatchObject({ price: 49_900, onHand: 0, size: '300 gm', netUnit: 'G', weightSource: 'ESTIMATED', dataFlags: ['STOCK_AMBIGUOUS', 'WEIGHT_ESTIMATED'] });
    expect(resin.product).toMatchObject({ name: 'ArtQ Ultra Clear 2:1 Epoxy Resin', importKey: '2-1-epoxy-resin', slug: '2-1-epoxy-resin', dataFlags: [] });
    expect((await variantBySku('RES-31-400G')).dataFlags).toContain('STOCK_AMBIGUOUS');                  // "Stock Out"
    expect((await variantBySku('RES-UV-50G')).dataFlags).toContain('PRICE_CONFLICT');
    expect(await variantBySku('MW-MOM-11X6')).toMatchObject({ onHand: 7, inventoryCountedAt: null });   // numeric stock kept, uncounted
    expect((await variantBySku('MW-MOM-11X6')).product.dataFlags).toEqual(['COLOUR_REVIEW']);
    expect(await variantBySku('TWF-05IN-8X10')).toMatchObject({ thickness: '0.5 inch', size: '8×10 in', dataFlags: expect.arrayContaining(['PRICE_REVIEW', 'STOCK_AMBIGUOUS']) });
    expect((await variantBySku('TWF-1IN-HEX8')).product.name).toBe('Teak Wood Hexagon Frame');
    expect((await variantBySku('TWF-1IN-9X12-DF')).product.name).toBe('Teak Wood Double Frame (Plywood Base)');
    const teak = await prisma.product.findFirstOrThrow({ where: { importKey: 'teak-wood-frame' }, include: { variants: true } });
    expect(teak.variants).toHaveLength(14);
    expect(teak.dataFlags).toEqual([]);                                                                  // shared family copy is not a "copy"
    expect((await variantBySku('PIG-MICA-PWHITE')).dataFlags).toEqual(expect.arrayContaining(['SIZE_CONFLICT', 'STOCK_AMBIGUOUS']));
    expect((await variantBySku('PIG-MICA-PBRONZE')).product.dataFlags).toContain('DESCRIPTION_SUSPECT_COPY');
    expect((await variantBySku('ESS-BUBBLE-50G')).product.dataFlags).toContain('DESCRIPTION_SUSPECT_COPY');
    expect(await variantBySku('ESS-BLOW-TORCH')).toMatchObject({ price: null, dataFlags: expect.arrayContaining(['PRICE_MISSING']) });
    expect((await variantBySku('HOOP-ACR-8IN')).product.dataFlags).toEqual(['COPY_REVIEW']);
    expect((await variantBySku('MHF-RND-6IN')).product).toMatchObject({ name: 'Round Mahogany Frame with Acrylic Base', dataFlags: ['COPY_REVIEW'] });
    expect((await variantBySku('ESS-STAND-8IN')).product.name).toBe('Folding Electroplated Metal Stand');
    const gel = await variantBySku('PIG-GEL-MGOLD');
    expect(gel).toMatchObject({ price: 9000, mrp: 12_000, onHand: 20, dataFlags: ['WEIGHT_ESTIMATED'] });
    expect(gel.product).toMatchObject({ name: 'Metallic Gold Gel Pigment', dataFlags: [] });
    const failures = await val<string[]>(prisma, `SELECT product_readiness_failures(p) FROM products p WHERE import_key = 'magic-silica-gel-500gm'`);
    expect(failures).toEqual(expect.arrayContaining(['no_tax', 'no_image', 'stock_uncounted', 'shipping_data']));
  });

  it('✅ re-importing the result file changes no stock and creates nothing', async () => {
    const result = await call('get', `/imports/${importId}/result.xlsx`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(result.headers['content-type']).toContain('spreadsheetml');
    const before = await prisma.productVariant.aggregate({ _sum: { onHand: true } });
    const movementsBefore = await prisma.inventoryMovement.count();
    const again = await imported(result.body as Buffer);
    const imp = await prisma.productImport.findUniqueOrThrow({ where: { id: again } });
    expect(imp).toMatchObject({ status: 'COMPLETED', createdCount: 0, failedCount: 0, reviewCount: 0 });
    expect(imp.unchangedCount + imp.updatedCount).toBe(98);
    expect(await prisma.product.count()).toBe(64);
    expect(await prisma.productVariant.count()).toBe(98);
    expect((await prisma.productVariant.aggregate({ _sum: { onHand: true } }))._sum.onHand).toBe(before._sum.onHand);
    expect(await prisma.inventoryMovement.count()).toBe(movementsBefore);
    expect((await variantBySku('RES-21-300G')).dataFlags).toEqual(['STOCK_AMBIGUOUS', 'WEIGHT_ESTIMATED']);   // flags survive the round trip
    expect((await variantBySku('PIG-MICA-PBRONZE')).product.dataFlags).toContain('DESCRIPTION_SUSPECT_COPY');
  });
});

describe('resume and retries', () => {
  it('✅ a crash in the middle of a batch rolls that batch back; running again finishes without duplicates', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ 'Product Key': `crash-${Math.floor(i / 3)}`, 'Category (Type) *': 'Crash Type', 'Subcategory *': 'Crash Cat', 'Product Name *': `Crash ${Math.floor(i / 3)}`, 'Size / Volume *': `${i + 1} gm`, 'Selling Price (₹) *': 100 + i, 'Stock Quantity *': 5, SKU: `CRASH-${i}` }));
    const id = await validated(await workbook(rows));
    await call('post', `/imports/${id}/confirm`, ADMIN, {});
    await expect(imports.apply(id, { beforeCommit: (b) => { if (b === 2) throw new Error('worker killed'); } })).rejects.toThrow('worker killed');
    expect(await prisma.productImportRow.count({ where: { importId: id, status: 'CREATED' } })).toBe(25);   // batch 1 committed
    expect(await prisma.productVariant.count({ where: { sku: { startsWith: 'CRASH-' } } })).toBe(25);
    expect(await imports.apply(id)).toBe('DONE');
    expect(await prisma.productVariant.count({ where: { sku: { startsWith: 'CRASH-' } } })).toBe(60);
    expect(await prisma.product.count({ where: { importKey: { startsWith: 'crash-' } } })).toBe(20);
    expect(await prisma.inventoryMovement.count({ where: { importId: id } })).toBe(60);              // one initial movement each
    expect((await prisma.productVariant.aggregate({ where: { sku: { startsWith: 'CRASH-' } }, _sum: { onHand: true } }))._sum.onHand).toBe(300);
    expect((await prisma.productImportRow.findFirstOrThrow({ where: { importId: id, rowNumber: 30 } })).attempts).toBe(2);
    expect((await prisma.productImport.findUniqueOrThrow({ where: { id } })).status).toBe('COMPLETED');
  });

  it('✅ the worker process is killed (SIGKILL) inside a batch; restarting completes without duplicates', async () => {
    const rows = Array.from({ length: 70 }, (_, i) => ({ 'Product Key': `kill-${Math.floor(i / 7)}`, 'Category (Type) *': 'Kill Type', 'Product Name *': `Kill ${Math.floor(i / 7)}`, 'Size / Volume *': `${i + 1} gm`, 'Selling Price (₹) *': 10 + i, 'Stock Quantity *': 4, SKU: `KILL-${i}` }));
    const id = await validated(await workbook(rows));
    await call('post', `/imports/${id}/confirm`, ADMIN, {});
    const child = spawn(process.execPath, ['--import', 'tsx', join(API_ROOT, 'test', 'helpers', 'import-apply-child.ts'), String(id)], { cwd: API_ROOT, env: { ...process.env, DATABASE_URL: db.url }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (d: Buffer) => { if (d.toString().includes('IN_BATCH_2')) resolve(); });
      child.on('exit', (code) => reject(new Error(`child exited early (${code})`)));
    });
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    // Batch 1 committed; batch 2 (open transaction) was rolled back by PostgreSQL when the connection died.
    await expect.poll(async () => prisma.productVariant.count({ where: { sku: { startsWith: 'KILL-' } } }), { timeout: 10_000 }).toBe(25);
    expect(await imports.apply(id)).toBe('DONE');
    expect(await prisma.productVariant.count({ where: { sku: { startsWith: 'KILL-' } } })).toBe(70);
    expect(await prisma.product.count({ where: { importKey: { startsWith: 'kill-' } } })).toBe(10);
    expect(await prisma.inventoryMovement.count({ where: { importId: id } })).toBe(70);
    expect((await prisma.productVariant.aggregate({ where: { sku: { startsWith: 'KILL-' } }, _sum: { onHand: true } }))._sum.onHand).toBe(280);
    expect(await prisma.productImport.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'COMPLETED', createdCount: 70 });
  }, 120_000);

  it('a batch that keeps crashing gives up after 3 attempts; the rest still imports', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ 'Category (Type) *': 'Retry Type', 'Product Name *': `Retry ${i}`, 'Size / Volume *': '1 kg', 'Selling Price (₹) *': 100, 'Stock Quantity *': 1, SKU: `RETRY-${i}` }));
    const id = await validated(await workbook(rows));
    await call('post', `/imports/${id}/confirm`, ADMIN, {});
    for (let i = 0; i < 3; i++) await expect(imports.apply(id, { beforeCommit: (b) => { if (b === 1) throw new Error('poison'); } })).rejects.toThrow('poison');
    expect(await imports.apply(id)).toBe('DONE');
    const imp = await prisma.productImport.findUniqueOrThrow({ where: { id } });
    expect(imp).toMatchObject({ status: 'COMPLETED_WITH_ERRORS', failedCount: 25, createdCount: 5 });
    expect((await prisma.productImportRow.findFirstOrThrow({ where: { importId: id, rowNumber: 2 } })).messages).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'GAVE_UP' })]));
  });

  it('two workers applying the same import at once: each row applied once', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ 'Category (Type) *': 'Twin Type', 'Product Name *': `Twin ${i % 10}`, 'Size / Volume *': `${i + 1} ml`, 'Selling Price (₹) *': 50, 'Stock Quantity *': 2, SKU: `TWIN-${i}` }));
    const id = await validated(await workbook(rows));
    await call('post', `/imports/${id}/confirm`, ADMIN, {});
    await Promise.all([imports.apply(id), imports.apply(id)]);
    expect(await prisma.productVariant.count({ where: { sku: { startsWith: 'TWIN-' } } })).toBe(50);
    expect(await prisma.product.count({ where: { importKey: { startsWith: 'twin-' } } })).toBe(10);
    expect(await prisma.inventoryMovement.count({ where: { importId: id } })).toBe(50);
    expect(await prisma.productImport.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'COMPLETED', createdCount: 50, failedCount: 0 });
  });
});

describe('concurrent edits, review and live products', () => {
  it('a variant edited after validation is not overwritten (NEEDS_REVIEW); resolve applies or skips', async () => {
    await imported(await workbook([{ 'Category (Type) *': 'Review Type', 'Product Name *': 'Review Kit', 'Size / Volume *': '1 kg', 'Selling Price (₹) *': 100, 'Stock Quantity *': 1, SKU: 'REV-1' },
      { 'Category (Type) *': 'Review Type', 'Product Name *': 'Review Kit', 'Size / Volume *': '2 kg', 'Selling Price (₹) *': 200, 'Stock Quantity *': 1, SKU: 'REV-2' }]));
    const id = await validated(await workbook([{ 'Category (Type) *': 'Review Type', 'Product Name *': 'Review Kit', 'Size / Volume *': '1 kg', 'Selling Price (₹) *': 111, 'Stock Quantity *': 1, SKU: 'REV-1' },
      { 'Category (Type) *': 'Review Type', 'Product Name *': 'Review Kit', 'Size / Volume *': '2 kg', 'Selling Price (₹) *': 222, 'Stock Quantity *': 1, SKU: 'REV-2' }]));
    // Someone edits both variants in the admin between validation and apply.
    await prisma.productVariant.updateMany({ where: { sku: { in: ['REV-1', 'REV-2'] } }, data: { price: 15_000, version: { increment: 1 } } });
    await call('post', `/imports/${id}/confirm`, ADMIN, {});
    await imports.apply(id);
    expect(await prisma.productImport.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'COMPLETED_WITH_ERRORS', reviewCount: 2 });
    expect((await variantBySku('REV-1')).price).toBe(15_000);
    const rows = (await call('get', `/imports/${id}/rows?status=NEEDS_REVIEW`)).body.data as { id: number; sku: string }[];
    expect(rows).toHaveLength(2);
    const [r1, r2] = [rows.find((r) => r.sku === 'REV-1')!, rows.find((r) => r.sku === 'REV-2')!];
    expect((await call('post', `/imports/${id}/rows/${r1.id}/resolve`, ADMIN, { action: 'apply' })).body.rows).toMatchObject({ UPDATED: 1, NEEDS_REVIEW: 1 });
    expect((await variantBySku('REV-1')).price).toBe(11_100);
    await call('post', `/imports/${id}/rows/${r2.id}/resolve`, ADMIN, { action: 'skip' });
    expect((await variantBySku('REV-2')).price).toBe(15_000);
    expect((await call('post', `/imports/${id}/rows/${r2.id}/resolve`, ADMIN, { action: 'apply' })).status).toBe(422);   // already resolved
    expect((await call('post', `/imports/${id}/rows/${r2.id}/resolve`, ADMIN, { action: 'maybe' })).status).toBe(400);
  });

  it('an import that would make a live product fail a check leaves it alone (NEEDS_REVIEW)', async () => {
    await imported(await workbook([{ 'Category (Type) *': 'Live Type', 'Subcategory *': 'Live Cat', 'Product Name *': 'Live Frame', Description: 'x', 'Size / Volume *': '4x6', 'Selling Price (₹) *': 300, 'Stock Quantity *': 3, SKU: 'LIVE-1', 'Parcel Weight (kg)': 0.3 }]));
    const v = await variantBySku('LIVE-1');
    await prisma.product.update({ where: { id: v.productId }, data: { description: 'A frame', hsnCode: '4414', gstRate: 5, taxApprovedAt: new Date() } });
    await prisma.$transaction((tx) => fn.adjustOnHand(tx, { rows: [{ variantId: v.id, kind: 'RECOUNT', quantity: 3 }], actorId: null }));
    const m = await val<number>(prisma, `INSERT INTO media (key, visibility, kind, declared_mime, declared_size, owner_scope, status, updated_at) VALUES ($1,'PUBLIC','IMAGE','image/webp',1,'admin','READY',now()) RETURNING id`, `k-${uniq()}`);
    await prisma.productImage.create({ data: { productId: v.productId, mediaId: m, isCover: true } });
    await prisma.$executeRawUnsafe(`UPDATE products SET status='ACTIVE', is_publishable=true, published_at=now() WHERE id=$1`, v.productId);
    const id = await imported(await workbook([{ 'Category (Type) *': 'Live Type', 'Subcategory *': 'Live Cat', 'Product Name *': 'Live Frame', 'Size / Volume *': '4x6', 'Stock Quantity *': 3, SKU: 'LIVE-1', 'Parcel Weight (kg)': 0.3 }]));
    const row = await prisma.productImportRow.findFirstOrThrow({ where: { importId: id } });
    expect(row.status).toBe('NEEDS_REVIEW');
    expect(JSON.stringify(row.messages)).toContain('Unpublish it first');
    expect(await variantBySku('LIVE-1')).toMatchObject({ price: 30_000, product: { status: 'ACTIVE' } });
  });
});

describe('validation and options', () => {
  it('without "create missing", unknown types leave products Unassigned (never "Unknown")', async () => {
    const id = await imported(await workbook([{ 'Category (Type) *': 'Never Seen Type', 'Subcategory *': 'Nope', 'Product Name *': 'Orphan Product', 'Size / Volume *': '1 kg', 'Selling Price (₹) *': 10, 'Stock Quantity *': 0, SKU: 'ORPHAN-1', 'Is Active (TRUE/FALSE)': 'TRUE' }]), false);
    expect((await variantBySku('ORPHAN-1')).product).toMatchObject({ typeId: null, categoryId: null, status: 'DRAFT' });
    const msgs = JSON.stringify((await prisma.productImportRow.findFirstOrThrow({ where: { importId: id } })).messages);
    expect(msgs).toContain('TYPE_UNKNOWN');
    expect(msgs).toContain('IS_ACTIVE_IGNORED');
    expect(await prisma.productType.count({ where: { name: 'Never Seen Type' } })).toBe(0);
  });

  it('remote images are attached as the cover; a failed download is reported on the row', async () => {
    const m = await val<number>(prisma, `INSERT INTO media (key, visibility, kind, declared_mime, declared_size, owner_scope, status, updated_at) VALUES ($1,'PUBLIC','IMAGE','image/webp',1,'admin','UPLOADED',now()) RETURNING id`, `k-${uniq()}`);
    images.set('https://cdn.example.com/a.webp', m);
    const id = await imported(await workbook([{ 'Category (Type) *': 'Img Type', 'Product Name *': 'Img Product', 'Product Images': 'https://cdn.example.com/a.webp, https://cdn.example.com/missing.webp', 'Size / Volume *': '1 kg', 'Selling Price (₹) *': 10, 'Stock Quantity *': 0, SKU: 'IMG-1' }]));
    const v = await variantBySku('IMG-1');
    expect(await prisma.productImage.findMany({ where: { productId: v.productId } })).toEqual([expect.objectContaining({ mediaId: m, isCover: true })]);
    expect(JSON.stringify((await prisma.productImportRow.findFirstOrThrow({ where: { importId: id } })).messages)).toContain('IMAGE_FETCH_FAILED');
  });

  it('a SKU already used by another product fails that row at validation; the others import', async () => {
    const id = await imported(await workbook([
      { 'Category (Type) *': 'Sku Type', 'Product Name *': 'Not The Owner', 'Size / Volume *': '1 kg', 'Selling Price (₹) *': 10, 'Stock Quantity *': 0, SKU: 'RES-21-300G' },
      { 'Category (Type) *': 'Sku Type', 'Product Name *': 'Fine Product', 'Size / Volume *': '1 kg', 'Selling Price (₹) *': 10, 'Stock Quantity *': 0, SKU: 'FINE-1' },
    ]));
    expect(await prisma.productImport.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'COMPLETED_WITH_ERRORS', failedCount: 1, createdCount: 1 });
    expect((await variantBySku('RES-21-300G')).product.importKey).toBe('2-1-epoxy-resin');
  });

  it.each([
    ['a file that is not a workbook', Buffer.from('not a spreadsheet'), 'not a readable .xlsx'],
    ['a workbook without the catalogue columns', null, 'No sheet has the catalogue columns'],
  ])('%s → import FAILED with a clear reason', async (_l, buf, reason) => {
    let file = buf;
    if (!file) { const wb = new ExcelJS.Workbook(); wb.addWorksheet('Data').addRow(['Name', 'Price']); file = Buffer.from(await wb.xlsx.writeBuffer()); }
    const res = await call('post', '/imports', ADMIN, { kind: 'CATALOG', fileMediaId: await upload(file) });
    expect(await imports.validate(res.body.id, false)).toBe('FAILED');
    expect((await call('get', `/imports/${res.body.id}`)).body.status).toBe('FAILED');
    expect(JSON.stringify((await prisma.auditLog.findFirstOrThrow({ where: { action: 'import.failed', entityId: String(res.body.id) } })).after)).toContain(reason);
  });

  it('the file must be the caller\'s own finished import upload; a file still being checked waits; a rejected one fails', async () => {
    const other = await upload(CLIENT_FILE, { userId: STAFF.id });
    expect((await call('post', '/imports', ADMIN, { kind: 'CATALOG', fileMediaId: other })).body.error.code).toBe('MEDIA_NOT_USABLE');
    expect((await call('post', '/imports', ADMIN, { kind: 'CATALOG', fileMediaId: await upload(CLIENT_FILE, { scope: 'admin' }) })).body.error.code).toBe('MEDIA_NOT_USABLE');
    expect((await call('post', '/imports', ADMIN, { kind: 'CATALOG', fileMediaId: await upload(CLIENT_FILE, { status: 'PENDING_UPLOAD' }) })).body.error.code).toBe('MEDIA_NOT_USABLE');
    const processing = await upload(CLIENT_FILE, { status: 'PROCESSING' });
    const res = await call('post', '/imports', ADMIN, { kind: 'CATALOG', fileMediaId: processing });
    expect(await imports.validate(res.body.id, true)).toBe('WAITING');
    await prisma.media.update({ where: { id: processing }, data: { status: 'REJECTED', failureReason: 'content is unknown' } });
    expect(await imports.validate(res.body.id, true)).toBe('FAILED');
    // Stock-count imports (task 2.8) follow the same file rules: a rejected file is refused with its reason.
    expect((await call('post', '/imports', ADMIN, { kind: 'INVENTORY', fileMediaId: processing })).body.error).toMatchObject({ code: 'MEDIA_NOT_USABLE', message: 'The file was rejected: content is unknown' });
    expect((await call('post', '/imports', ADMIN, { kind: 'STOCK', fileMediaId: processing })).status).toBe(400);
  });

  it('confirm only once and only when validated; cancel stops what is left; a finished import cannot be cancelled', async () => {
    const id = await validated(await workbook([{ 'Category (Type) *': 'C', 'Product Name *': 'Cancel Me', 'Size / Volume *': '1 kg', 'Selling Price (₹) *': 1, 'Stock Quantity *': 0, SKU: 'CANCEL-1' }]));
    expect((await call('post', `/imports/${id}/cancel`, ADMIN, {})).body.status).toBe('CANCELLED');
    expect((await call('post', `/imports/${id}/confirm`, ADMIN, {})).body.error.code).toBe('INVALID_TRANSITION');
    expect((await prisma.productImportRow.findFirstOrThrow({ where: { importId: id } })).status).toBe('SKIPPED');
    expect(await prisma.productVariant.count({ where: { sku: 'CANCEL-1' } })).toBe(0);
    expect((await call('post', `/imports/${id}/cancel`, ADMIN, {})).status).toBe(422);
    expect((await call('get', '/imports/999999')).status).toBe(404);
  });
});

describe('variants that would share size, colour and thickness', () => {
  const row = (name: string, size: string, sku: string, extra: Record<string, unknown> = {}) => ({ 'Category (Type) *': 'Pigments', 'Subcategory *': 'Mica', 'Product Name *': name, 'Size / Volume *': size, 'Selling Price (₹) *': 149, 'Stock Quantity *': 5, SKU: sku, ...extra });
  const rowsOf = (id: number) => prisma.productImportRow.findMany({ where: { importId: id }, orderBy: { rowNumber: 'asc' } });

  it('the words after a size keep variants apart: “10 g Red” and “10 g Blue” become two variants', async () => {
    const n = uniq();
    await imported(await workbook([row(`Mica ${n}`, '10 g Red', `MR-${n}`), row(`Mica ${n}`, '10 g Blue', `MB-${n}`)]));
    expect((await variantBySku(`MR-${n}`.toUpperCase())).size).toBe('10 gm Red');
    expect((await variantBySku(`MB-${n}`.toUpperCase())).size).toBe('10 gm Blue');
  });

  it('two rows of one product with the same options: the second fails the check with the row it clashes with; the first imports', async () => {
    const n = uniq();
    const id = await validated(await workbook([row(`Dup ${n}`, '10 g', `D1-${n}`), row(`Dup ${n}`, '10 GM', `D2-${n}`), row(`Dup ${n}`, '10 g', `D3-${n}`, { Color: 'Gold' })]));
    const [a, b, c] = await rowsOf(id);
    expect([a!.status, b!.status, c!.status]).toEqual(['PENDING', 'FAILED', 'PENDING']);
    expect(b!.messages).toContainEqual({ code: 'OPTIONS_DUPLICATE', text: 'Row 2 of this product already has 10 gm; give each variant a different size, colour or thickness' });
    expect((await call('post', `/imports/${id}/confirm`, ADMIN, {})).status).toBe(200);
    expect(await imports.apply(id)).toBe('DONE');
    expect(await prisma.productVariant.count({ where: { sku: { in: [`D1-${n}`, `D2-${n}`, `D3-${n}`].map((x) => x.toUpperCase()) } } })).toBe(2);
    // The same options on different products are fine.
    expect((await rowsOf(await validated(await workbook([row(`Other ${n}`, '10 g', `O1-${n}`)]))))[0]!.status).toBe('PENDING');
  });

  it('a new SKU with the options of an existing variant fails the check and names that variant; the existing SKU updates', async () => {
    const n = uniq();
    await imported(await workbook([row(`Twin ${n}`, '25 g', `T1-${n}`)]));
    const id = await validated(await workbook([row(`Twin ${n}`, '25 g', `T1-${n}`), row(`Twin ${n}`, '25 g', `T2-${n}`)]));
    const [same, twin] = await rowsOf(id);
    expect(same!.status).toBe('PENDING');
    expect(twin!.status).toBe('FAILED');
    // In-file clash is reported once (row 2), not also as a clash with the stored variant.
    expect((twin!.messages as { code: string }[]).map((m) => m.code)).toContain('OPTIONS_DUPLICATE');
    const alone = await rowsOf(await validated(await workbook([row(`Twin ${n}`, '25 g', `T3-${n}`)])));
    expect(alone[0]!.status).toBe('FAILED');
    expect(alone[0]!.messages).toContainEqual({ code: 'OPTIONS_TAKEN', text: `Variant T1-${n.toUpperCase()} of this product already has 25 gm; use its SKU to update it, or change the size, colour or thickness` });
  });

  it('a clash that appears after the check (an admin adds the variant meanwhile) fails that row in plain words, not driver text', async () => {
    const n = uniq();
    await imported(await workbook([row(`Late ${n}`, '50 g', `L1-${n}`)]));
    const id = await validated(await workbook([row(`Late ${n}`, '75 g', `L2-${n}`)]));
    const product = (await variantBySku(`L1-${n}`.toUpperCase())).productId;
    await prisma.productVariant.create({ data: { productId: product, sku: `LX-${n}`.toUpperCase(), label: '75 gm', size: '75 gm', price: 100 } });
    expect((await call('post', `/imports/${id}/confirm`, ADMIN, {})).status).toBe(200);
    expect(await imports.apply(id)).toBe('DONE');
    const [r] = await rowsOf(id);
    expect(r!.status).toBe('FAILED');
    expect(r!.messages).toContainEqual({ code: 'APPLY_FAILED', text: 'Could not apply: another variant of this product already has this size, colour and thickness' });
  });
});

describe('aq_import_initial_stock (migration 0004)', () => {
  it('sets stock once on a brand-new variant (uncounted, one movement); refuses anything else', async () => {
    const productId = await val<number>(prisma, `INSERT INTO products (name, slug, updated_at) VALUES ('Fn Test', $1, now()) RETURNING id`, `fn-${uniq()}`);
    const v = await val<number>(prisma, `INSERT INTO product_variants (product_id, sku, label, updated_at) VALUES ($1, $2, 'x', now()) RETURNING id`, productId, `FN-${uniq()}`);
    const importId = (await prisma.productImport.create({ data: { kind: 'CATALOG', fileMediaId: await upload(CLIENT_FILE), fileName: 'fn.xlsx', createdBy: ADMIN.id } })).id;
    await prisma.$transaction((tx) => fn.importInitialStock(tx, { variantId: v, quantity: 7, importId, actorId: ADMIN.id }));
    expect(await prisma.productVariant.findUniqueOrThrow({ where: { id: v } })).toMatchObject({ onHand: 7, inventoryCountedAt: null });
    expect(await prisma.inventoryMovement.findMany({ where: { variantId: v } })).toEqual([expect.objectContaining({ reason: 'IMPORT_INITIAL', onHandDelta: 7, onHandAfter: 7, importId, actorId: ADMIN.id })]);
    await expect(prisma.$transaction((tx) => fn.importInitialStock(tx, { variantId: v, quantity: 3, importId, actorId: null }))).rejects.toThrow(/STOCK_ALREADY_SET/);
    // zero stock still records the movement, so a retry cannot set stock later either
    const z = await val<number>(prisma, `INSERT INTO product_variants (product_id, sku, label, size, updated_at) VALUES ($1, $2, 'z', '2 kg', now()) RETURNING id`, productId, `FN-${uniq()}`);
    await prisma.$transaction((tx) => fn.importInitialStock(tx, { variantId: z, quantity: 0, importId, actorId: null }));
    await expect(prisma.$transaction((tx) => fn.importInitialStock(tx, { variantId: z, quantity: 5, importId, actorId: null }))).rejects.toThrow(/STOCK_ALREADY_SET/);
    await expect(prisma.$transaction((tx) => fn.importInitialStock(tx, { variantId: v, quantity: -1, importId, actorId: null }))).rejects.toThrow(/INVALID_ADJUSTMENT/);
    await expect(prisma.$transaction((tx) => fn.importInitialStock(tx, { variantId: 999_999, quantity: 1, importId, actorId: null }))).rejects.toThrow(/NOT_FOUND:variant/);
  });
});

describe('AT-10 re-run against the real import endpoints', () => {
  it('STAFF → 403 on every catalogue import endpoint, audited; the list shows only stock-count imports', async () => {
    const before = await prisma.productImport.count();
    const media = await upload(CLIENT_FILE, { userId: STAFF.id });
    const someId = (await prisma.productImport.findFirstOrThrow({ where: { kind: 'CATALOG' } })).id;
    // Since task 2.8 STAFF (inventory:adjust) may list imports, but only stock-count ones.
    const list = await call('get', '/imports?limit=100', STAFF);
    expect(list.status).toBe(200);
    expect(list.body.data.some((i: { id: number }) => i.id === someId)).toBe(false);
    expect(list.body.data.every((i: { kind: string }) => i.kind === 'INVENTORY')).toBe(true);
    const attempts = [
      await call('get', '/imports/template.xlsx', STAFF),
      await call('post', '/imports', STAFF, { kind: 'CATALOG', fileMediaId: media }),
      await call('get', `/imports/${someId}`, STAFF),
      await call('get', `/imports/${someId}/rows`, STAFF),
      await call('post', `/imports/${someId}/confirm`, STAFF, {}),
      await call('post', `/imports/${someId}/cancel`, STAFF, {}),
      await call('get', `/imports/${someId}/result.xlsx`, STAFF),
    ];
    expect(attempts.map((a) => a.status)).toEqual([403, 403, 403, 403, 403, 403, 403]);
    expect(attempts.map((a) => a.body.error?.details)).toEqual(Array(7).fill({ permission: 'imports:catalog' }));
    expect(await prisma.productImport.count()).toBe(before);
    expect(await prisma.auditLog.count({ where: { actorId: STAFF.id, action: 'security.admin_rejected' } })).toBe(7);
  });

  it('a role without pricing:write cannot confirm a file that sets prices (service rule)', async () => {
    const id = await validated(await workbook([{ 'Category (Type) *': 'P', 'Product Name *': 'Priced', 'Size / Volume *': '1 kg', 'Selling Price (₹) *': 99, 'Stock Quantity *': 0, SKU: 'PRICED-1' }]));
    // No role holds imports:catalog without pricing:write, so STAFF is refused one step earlier (2.8); the pricing check
    // stays as a backstop. Either way nothing changes.
    await expect(imports.confirm(id, { userId: STAFF.id, role: 'STAFF' })).rejects.toMatchObject({ status: 403, details: { permission: 'imports:catalog' } });
    expect((await prisma.productImport.findUniqueOrThrow({ where: { id } })).status).toBe('VALIDATED');
  });

  it('the template downloads as a workbook with the official columns', async () => {
    const res = await call('get', '/imports/template.xlsx').buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as Buffer);
    expect((wb.getWorksheet('2. Products & Variants')!.getRow(1).values as string[]).slice(1, 5)).toEqual(['Product Key', 'Category (Type) *', 'Subcategory *', 'Product Name *']);
  });
});
