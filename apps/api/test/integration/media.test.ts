// Task 1.11: media pipeline on real PostgreSQL (in-memory object store; the compose suite uses real S3Mock).
// ✅ Spoofed MIME rejected; private URL denied to other users.
import type { PrismaClient, UserRole } from '@prisma/client';
import ExcelJS from 'exceljs';
import type { Express } from 'express';
import { pino } from 'pino';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdminRouter } from '../../src/admin/router.js';
import { createApp } from '../../src/app.js';
import { adminAuthRouter } from '../../src/auth/admin-routes.js';
import { authRouter } from '../../src/auth/routes.js';
import { AuthService, DEFAULT_AUTH_TIMINGS } from '../../src/auth/service.js';
import { MemorySessionCache } from '../../src/auth/session-cache.js';
import { hashPassword } from '../../src/lib/password.js';
import { customerMediaRouter, registerAdminMediaRoutes } from '../../src/media/routes.js';
import { MediaService, type Actor, type Purpose } from '../../src/media/service.js';
import type { RateLimiter } from '../../src/middleware/rateLimit.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { catalog, order, tx, uniq } from '../helpers/fixtures.js';
import { MemoryObjectStore } from '../helpers/memory-store.js';
import { startPostgres, type Service } from '../helpers/services.js';

const WEB = 'http://localhost:3000';
const ADMIN = 'http://localhost:5173';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const PASSWORD = 'media-password-123';
const BUCKETS = { PUBLIC: 'pub', PRIVATE: 'priv' };
const NO_LIMIT: RateLimiter = { hit: async () => ({ count: 0, resetMs: 60_000 }) };

let pg: Service, db: TestDb, prisma: PrismaClient, store: MemoryObjectStore, media: MediaService, app: Express;
const enqueued: number[] = [];

// Real files generated with sharp / exceljs.
let PNG400: Buffer, JPEG_EXIF: Buffer, XLSX: Buffer;
const MP4 = Buffer.concat([Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex'), Buffer.alloc(64)]);

beforeAll(async () => {
  pg = await startPostgres();
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  store = new MemoryObjectStore();
  media = new MediaService(prisma, { store, buckets: BUCKETS, publicBaseUrl: 'https://cdn.artq.test/' }, async (id) => { enqueued.push(id); });
  PNG400 = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#00756f' } }).png().toBuffer();
  JPEG_EXIF = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#ff0000' } }).jpeg().withMetadata({ exif: { IFD0: { Copyright: 'secret-location-data' } } }).toBuffer();
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Products').addRow(['Product Name', 'SKU']);
  XLSX = Buffer.from(await wb.xlsx.writeBuffer());

  const cache = new MemorySessionCache();
  const auth = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: WEB, adminUrl: 'http://localhost:5173' });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log: pino({ level: 'silent' }), hasRecentStepUp: (sid) => auth.hasRecentStepUp(sid) });
  registerAdminMediaRoutes(admin, media, prisma);
  app = createApp({ version: 't', origins: { storefront: [WEB], admin: [ADMIN] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [authRouter({ ...deps, service: auth, env: 'test', refreshMaxAgeS: 1, limiter: NO_LIMIT }), adminAuthRouter({ ...deps, service: auth, env: 'test', limiter: NO_LIMIT }), customerMediaRouter(deps, media), admin.router] });
}, 180_000);
afterAll(async () => { await db?.drop(); await pg?.stop(); });

async function login(role: UserRole) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  const u = await prisma.user.create({ data: { email, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword(PASSWORD) } });
  const res = await request(app).post(role === 'CUSTOMER' ? '/v1/auth/login' : '/v1/admin/auth/login').set('Origin', role === 'CUSTOMER' ? WEB : ADMIN).send({ email, password: PASSWORD });
  return { id: u.id, token: res.body.accessToken as string };
}
const adminPost = (path: string, token: string, body?: object) => request(app).post(`/v1/admin${path}`).set('Origin', ADMIN).set('Authorization', `Bearer ${token}`).send(body ?? {});
const adminGet = (path: string, token: string) => request(app).get(`/v1/admin${path}`).set('Authorization', `Bearer ${token}`);

/** presign → "browser upload" → complete, through the admin API. */
async function uploaded(token: string, purpose: Purpose, body: Buffer, mime: string, o: { uploadAs?: string; declaredSize?: number } = {}) {
  const p = await adminPost('/media/presign', token, { filename: 'Teak Frame <script>.png', contentType: mime, size: o.declaredSize ?? body.length, purpose });
  expect(p.status).toBe(201);
  const m = await prisma.media.findUniqueOrThrow({ where: { id: p.body.media.id } });
  store.upload(BUCKETS[m.visibility], m.key, body, o.uploadAs ?? mime);
  return { id: m.id as number, key: m.key, presign: p, complete: await adminPost(`/media/${m.id}/complete`, token) };
}

describe('presign', () => {
  it('validates purpose, type and size; the key never contains the file name; the URL signs type and length', async () => {
    const a = await login('ADMIN');
    const r = await adminPost('/media/presign', a.token, { filename: '../../etc/passwd.png', contentType: 'IMAGE/PNG', size: 1234, purpose: 'product-image' });
    expect(r.status).toBe(201);
    expect(r.body.upload).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/png', 'Content-Length': '1234' } });
    expect(r.body.upload.url).toContain('type=image%2Fpng&len=1234&exp=300');
    const m = await prisma.media.findUniqueOrThrow({ where: { id: r.body.media.id } });
    expect(m).toMatchObject({ status: 'PENDING_UPLOAD', visibility: 'PUBLIC', kind: 'IMAGE', declaredMime: 'image/png', declaredSize: 1234, uploadedBy: a.id, ownerScope: 'admin' });
    expect(m.key).toMatch(/^public\/product-image\/\d{4}-\d{2}\/[0-9a-f-]{36}\.png$/);
    expect(m.key).not.toContain('passwd');
    expect(await prisma.auditLog.count({ where: { actorId: a.id, action: 'media.presign' } })).toBe(1);
    expect((await adminPost('/media/presign', a.token, { filename: 'i.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 10, purpose: 'catalog-import' })).status).toBe(201);
  });

  it.each([
    ['type not allowed for the purpose', { contentType: 'image/gif', size: 10, purpose: 'product-image' }, 422, 'MEDIA_TYPE_NOT_ALLOWED'],
    ['SVG (script-capable) is never allowed', { contentType: 'image/svg+xml', size: 10, purpose: 'cms-image' }, 422, 'MEDIA_TYPE_NOT_ALLOWED'],
    ['image over 15 MB', { contentType: 'image/png', size: 15 * 1024 * 1024 + 1, purpose: 'product-image' }, 422, 'MEDIA_TOO_LARGE'],
    ['video over 50 MB', { contentType: 'video/mp4', size: 50 * 1024 * 1024 + 1, purpose: 'video' }, 422, 'MEDIA_TOO_LARGE'],
    ['xlsx over 5 MB', { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 5 * 1024 * 1024 + 1, purpose: 'catalog-import' }, 422, 'MEDIA_TOO_LARGE'],
    ['a customer purpose from the admin', { contentType: 'image/png', size: 10, purpose: 'return-photo' }, 400, 'VALIDATION_ERROR'],
    ['zero bytes', { contentType: 'image/png', size: 0, purpose: 'product-image' }, 400, 'VALIDATION_ERROR'],
  ])('rejects %s', async (_d, body, status, code) => {
    const a = await login('ADMIN');
    const r = await adminPost('/media/presign', a.token, { filename: 'x', ...body });
    expect(r.status).toBe(status);
    expect(r.body.error.code).toBe(code);
  });

  it('exactly at the limit is fine; STAFF (no media:write) and customers cannot presign admin media', async () => {
    const a = await login('ADMIN');
    expect((await adminPost('/media/presign', a.token, { filename: 'x', contentType: 'image/png', size: 15 * 1024 * 1024, purpose: 'product-image' })).status).toBe(201);
    expect((await adminPost('/media/presign', (await login('STAFF')).token, { filename: 'x', contentType: 'image/png', size: 10, purpose: 'product-image' })).status).toBe(403);
    expect((await adminPost('/media/presign', (await login('CUSTOMER')).token, { filename: 'x', contentType: 'image/png', size: 10, purpose: 'product-image' })).status).toBe(401);
  });
});

describe('complete', () => {
  it('HEAD matches ⇒ UPLOADED and enqueued once; completing again is harmless', async () => {
    const a = await login('ADMIN');
    enqueued.length = 0;
    const u = await uploaded(a.token, 'product-image', PNG400, 'image/png');
    expect(u.complete.status).toBe(200);
    expect(u.complete.body.media).toMatchObject({ status: 'UPLOADED', size: PNG400.length });
    expect((await adminPost(`/media/${u.id}/complete`, a.token)).body.media.status).toBe('UPLOADED');
    expect(enqueued).toEqual([u.id]);
  });

  it.each([
    ['object never uploaded', 'missing'],
    ['size differs from the presign', 'size'],
    ['Content-Type differs from the presign', 'type'],
  ])('%s ⇒ 422 MEDIA_REJECTED and REJECTED, never enqueued', async (_d, kind) => {
    const a = await login('ADMIN');
    enqueued.length = 0;
    const p = await adminPost('/media/presign', a.token, { filename: 'x.png', contentType: 'image/png', size: PNG400.length, purpose: 'product-image' });
    const m = await prisma.media.findUniqueOrThrow({ where: { id: p.body.media.id } });
    if (kind === 'size') store.upload(BUCKETS.PUBLIC, m.key, Buffer.concat([PNG400, Buffer.alloc(1)]), 'image/png');
    if (kind === 'type') store.upload(BUCKETS.PUBLIC, m.key, PNG400, 'text/html');
    const r = await adminPost(`/media/${m.id}/complete`, a.token);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('MEDIA_REJECTED');
    expect((await prisma.media.findUniqueOrThrow({ where: { id: m.id } })).status).toBe('REJECTED');
    expect(enqueued).toEqual([]);
  });

  it('only the uploader can complete: another admin gets 404', async () => {
    const a = await login('ADMIN');
    const p = await adminPost('/media/presign', a.token, { filename: 'x.png', contentType: 'image/png', size: 10, purpose: 'product-image' });
    expect((await adminPost(`/media/${p.body.media.id}/complete`, (await login('SUPER_ADMIN')).token)).status).toBe(404);
    expect((await adminPost('/media/999999/complete', a.token)).status).toBe(404);
  });
});

describe('processing', () => {
  const run = async (id: number) => media.process(id);

  it('a real PNG becomes READY with WebP renditions up to its own width, a placeholder and a checksum', async () => {
    const a = await login('ADMIN');
    const u = await uploaded(a.token, 'product-image', PNG400, 'image/png');
    expect(await run(u.id)).toBe('READY');
    const m = await prisma.media.findUniqueOrThrow({ where: { id: u.id } });
    expect(m).toMatchObject({ status: 'READY', detectedMime: 'image/png', width: 400, height: 300, sizeBytes: PNG400.length });
    expect(m.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(m.renditions as object).sort((x, y) => Number(x) - Number(y))).toEqual(['160', '320', '400']);
    for (const key of Object.values(m.renditions as Record<string, string>)) {
      const obj = store.objects.get(`${BUCKETS.PUBLIC}/${key}`)!;
      expect(obj.contentType).toBe('image/webp');
      expect(obj.cacheControl).toContain('immutable');
      expect((await sharp(obj.body).metadata()).format).toBe('webp');
    }
    expect(m.placeholder).toMatch(/^data:image\/webp;base64,/);
    const view = (await adminGet(`/media/${u.id}`, a.token)).body.media;
    expect(view.renditions['320']).toBe(`https://cdn.artq.test/${(m.renditions as Record<string, string>)['320']}`);
    expect(await run(u.id)).toBe('SKIPPED');                                  // already done
  });

  it('EXIF/metadata (e.g. GPS) is stripped from renditions', async () => {
    const a = await login('ADMIN');
    expect((await sharp(JPEG_EXIF).metadata()).exif).toBeDefined();
    const u = await uploaded(a.token, 'cms-image', JPEG_EXIF, 'image/jpeg');
    expect(await run(u.id)).toBe('READY');
    const key = (await prisma.media.findUniqueOrThrow({ where: { id: u.id } })).renditions as Record<string, string>;
    const out = store.objects.get(`${BUCKETS.PUBLIC}/${key['160']}`)!.body;
    expect((await sharp(out).metadata()).exif).toBeUndefined();
    expect(out.includes(Buffer.from('secret-location-data'))).toBe(false);
  });

  it('ACCEPTANCE: a spoofed MIME type is rejected (PNG bytes declared as JPEG; HTML declared as PNG)', async () => {
    const a = await login('ADMIN');
    const png = await uploaded(a.token, 'product-image', PNG400, 'image/jpeg');
    expect(png.complete.status).toBe(200);                                      // HEAD trusts the declared type…
    expect(await run(png.id)).toBe('REJECTED');                                 // …the magic bytes do not
    expect((await prisma.media.findUniqueOrThrow({ where: { id: png.id } })).failureReason).toBe('content is image/png, declared image/jpeg');
    const html = await uploaded(a.token, 'product-image', Buffer.from('<html><script>alert(1)</script></html>'), 'image/png');
    expect(await run(html.id)).toBe('REJECTED');
    expect((await prisma.media.findUniqueOrThrow({ where: { id: html.id } })).failureReason).toBe('content is unknown, declared image/png');
    expect([...store.objects.keys()].filter((k) => k.includes(png.key.replace(/\.\w+$/, '/')))).toEqual([]);   // no renditions were written
    expect([...store.objects.keys()].some((k) => k.endsWith(png.key))).toBe(true);                                 // (sanity: the original is there)
  });

  it('a truncated image and a decompression bomb (> 40 MP) are REJECTED, not retried', async () => {
    const a = await login('ADMIN');
    const broken = await uploaded(a.token, 'product-image', PNG400.subarray(0, 120), 'image/png');
    expect(await run(broken.id)).toBe('REJECTED');
    expect((await prisma.media.findUniqueOrThrow({ where: { id: broken.id } })).failureReason).toMatch(/could not be decoded/);
    const bomb = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: '#000' } }).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);                          // tiny file, 48 MP when decoded
    const b = await uploaded(a.token, 'product-image', bomb, 'image/png');
    expect(await run(b.id)).toBe('REJECTED');
    expect((await prisma.media.findUniqueOrThrow({ where: { id: b.id } })).failureReason).toMatch(/pixel limit|could not be decoded/i);
  });

  it('video (mp4 magic) and xlsx (zip with workbook) become READY without renditions', async () => {
    const a = await login('ADMIN');
    const v = await uploaded(a.token, 'video', MP4, 'video/mp4');
    expect(await run(v.id)).toBe('READY');
    const x = await uploaded(a.token, 'catalog-import', XLSX, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(await run(x.id)).toBe('READY');
    expect(await prisma.media.findUniqueOrThrow({ where: { id: x.id } })).toMatchObject({ visibility: 'PRIVATE', ownerScope: 'import', detectedMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  });

  it('a storage outage ⇒ FAILED (retryable); the retry endpoint re-enqueues; only FAILED can be retried', async () => {
    const a = await login('ADMIN');
    const u = await uploaded(a.token, 'product-image', PNG400, 'image/png');
    store.failGets = 1;
    await expect(run(u.id)).rejects.toThrow('simulated storage outage');
    expect(await prisma.media.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({ status: 'FAILED', failureReason: 'storage: simulated storage outage' });
    enqueued.length = 0;
    const r = await adminPost(`/media/${u.id}/retry`, a.token);
    expect(r.status).toBe(202);
    expect(enqueued).toEqual([u.id]);
    expect(await run(u.id)).toBe('READY');
    expect((await adminPost(`/media/${u.id}/retry`, a.token)).body.error.code).toBe('INVALID_TRANSITION');
  });

  it('two workers on the same media: one processes, the other skips', async () => {
    const a = await login('ADMIN');
    const u = await uploaded(a.token, 'product-image', PNG400, 'image/png');
    expect((await Promise.all([run(u.id), run(u.id)])).sort()).toEqual(['READY', 'SKIPPED']);
  });
});

describe('private media', () => {
  async function returnPhoto(customer: { id: number }, orderId: number) {
    const actor: Actor = { userId: customer.id, audience: 'customer', scope: `return:${orderId}` };
    const p = await media.presign({ filename: 'damage.jpg', contentType: 'image/png', size: PNG400.length, purpose: 'return-photo' }, actor);
    const m = await prisma.media.findUniqueOrThrow({ where: { id: p.media.id } });
    store.upload(BUCKETS.PRIVATE, m.key, PNG400, 'image/png');
    await media.complete(m.id, actor);
    await media.process(m.id);
    return m.id;
  }

  it('ACCEPTANCE: a private file is served only to its owner (302 to a short-lived URL); other users get 404', async () => {
    const owner = await login('CUSTOMER');
    const other = await login('CUSTOMER');
    const cat = await catalog(prisma, [[{ price: 1000, onHand: 5 }]]);
    const o = await tx(prisma, (t) => order(t, { lines: [{ variantId: cat.products[0]!.variantIds[0]!, qty: 1 }], reserve: false }));
    await prisma.order.update({ where: { id: o.orderId }, data: { userId: owner.id } });
    const id = await returnPhoto(owner, o.orderId);
    const mine = await request(app).get(`/v1/me/attachments/${id}`).set('Authorization', `Bearer ${owner.token}`);
    expect(mine.status).toBe(302);
    expect(mine.headers.location).toMatch(/^https:\/\/storage\.test\/priv\/private\/return-photo\/.+\?exp=300/);
    expect(mine.headers['cache-control']).toBe('private, no-store');
    expect((await request(app).get(`/v1/me/attachments/${id}?w=160`).set('Authorization', `Bearer ${owner.token}`)).headers.location).toContain('/w160.webp');
    const theirs = await request(app).get(`/v1/me/attachments/${id}`).set('Authorization', `Bearer ${other.token}`);
    expect(theirs.status).toBe(404);
    expect(theirs.headers.location).toBeUndefined();
    expect((await request(app).get(`/v1/me/attachments/${id}`)).status).toBe(401);
    expect((await request(app).get('/v1/me/attachments/999999').set('Authorization', `Bearer ${owner.token}`)).status).toBe(404);
  });

  it('the order owner may read return photos of that order even if a guest uploaded them before linking', async () => {
    const owner = await login('CUSTOMER');
    const cat = await catalog(prisma, [[{ price: 1000, onHand: 5 }]]);
    const o = await tx(prisma, (t) => order(t, { lines: [{ variantId: cat.products[0]!.variantIds[0]!, qty: 1 }], reserve: false }));
    const guestActor: Actor = { userId: null, audience: 'customer', scope: `return:${o.orderId}` };
    const p = await media.presign({ filename: 'x', contentType: 'image/png', size: PNG400.length, purpose: 'return-photo' }, guestActor);
    await prisma.order.update({ where: { id: o.orderId }, data: { userId: owner.id } });
    expect((await request(app).get(`/v1/me/attachments/${p.media.id}`).set('Authorization', `Bearer ${owner.token}`)).status).toBe(302);
    await expect(media.privateUrl(p.media.id, { userId: null, audience: 'customer', scope: 'return:999' })).rejects.toMatchObject({ status: 404 });
    expect(await media.privateUrl(p.media.id, guestActor)).toMatch(/^https:\/\/storage\.test\/priv\//);
  });

  it('staff access to private media follows the permission for its scope', async () => {
    const admin = await login('ADMIN');
    const x = await uploaded(admin.token, 'catalog-import', XLSX, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const asAdmin = await adminGet(`/media/${x.id}/file`, admin.token);
    expect(asAdmin.status).toBe(302);
    expect(asAdmin.headers.location).toContain('download=artq-');                  // non-images download as attachments
    expect((await adminGet(`/media/${x.id}/file`, (await login('STAFF')).token)).status).toBe(404);      // no imports:catalog
    const pub = await uploaded(admin.token, 'product-image', PNG400, 'image/png');
    expect((await adminGet(`/media/${pub.id}/file`, admin.token)).status).toBe(404);                      // public media have CDN URLs
  });
});

describe('claim and purge', () => {
  it('claim needs READY media in the same scope', async () => {
    const actor: Actor = { userId: null, audience: 'customer', scope: 'custom-work:abc' };
    const p = await media.presign({ filename: 'x', contentType: 'image/png', size: PNG400.length, purpose: 'custom-work' }, actor);
    await expect(prisma.$transaction((t) => media.claim(t, p.media.id, 'custom-work:abc'))).rejects.toMatchObject({ code: 'MEDIA_NOT_READY' });
    const m = await prisma.media.findUniqueOrThrow({ where: { id: p.media.id } });
    store.upload(BUCKETS.PRIVATE, m.key, PNG400, 'image/png');
    await media.complete(m.id, actor);
    await media.process(m.id);
    await expect(prisma.$transaction((t) => media.claim(t, m.id, 'custom-work:other'))).rejects.toMatchObject({ code: 'MEDIA_NOT_READY' });
    await prisma.$transaction((t) => media.claim(t, m.id, 'custom-work:abc'));
    expect((await prisma.media.findUniqueOrThrow({ where: { id: m.id } })).claimedAt).not.toBeNull();
  });

  it('after 24 h: unclaimed private uploads and never-uploaded presigns are deleted; claimed and public media stay', async () => {
    const admin = await login('ADMIN');
    const unclaimed = await uploaded(admin.token, 'catalog-import', XLSX, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const claimed = await uploaded(admin.token, 'catalog-import', XLSX, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await prisma.media.update({ where: { id: claimed.id }, data: { claimedAt: new Date() } });
    const never = await adminPost('/media/presign', admin.token, { filename: 'x', contentType: 'image/png', size: 10, purpose: 'product-image' });
    const pub = await uploaded(admin.token, 'product-image', PNG400, 'image/png');
    await media.process(pub.id);
    const ids = [unclaimed.id, claimed.id, never.body.media.id, pub.id];
    await prisma.media.updateMany({ where: { id: { in: ids } }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    await media.purgeStale();
    const rows = await prisma.media.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => [r.id, r.deletedAt !== null])).toEqual([[unclaimed.id, true], [claimed.id, false], [never.body.media.id, true], [pub.id, false]]);
    expect(store.objects.has(`${BUCKETS.PRIVATE}/${unclaimed.key}`)).toBe(false);
    expect(store.objects.has(`${BUCKETS.PRIVATE}/${claimed.key}`)).toBe(true);
    expect((await adminGet(`/media/${unclaimed.id}`, admin.token)).status).toBe(404);
  });
});
