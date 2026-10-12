// Task 6.1 on real PostgreSQL + Redis: CMS & Messages through the admin endpoints. Slides (image and dates checked,
// the button needs text and link, live flag, reorder, delete), reels (a video, an existing product, an Instagram link),
// testimonials (rating 1–5), FAQs (reorder within a group only), pages (rich text cleaned, unique address, the footer's
// pages can't be renamed or deleted), home settings (the shared rules, the public settings cache dropped), the messages
// inbox (filters, private attachments as short links, status and note), permissions and audit.
import type { PrismaClient, UserRole } from '@prisma/client';
import type { Express } from 'express';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdminRouter } from '../../src/admin/router.js';
import { createApp } from '../../src/app.js';
import { adminAuthRouter } from '../../src/auth/admin-routes.js';
import { AuthService, DEFAULT_AUTH_TIMINGS } from '../../src/auth/service.js';
import { RedisSessionCache } from '../../src/auth/session-cache.js';
import { registerCmsRoutes } from '../../src/cms/routes.js';
import { CmsService } from '../../src/cms/service.js';
import { hashPassword } from '../../src/lib/password.js';
import { MediaService } from '../../src/media/service.js';
import { seedGeo, seedSettings, seedShipping } from '../../src/seed/steps.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { catalog, tx, uniq } from '../helpers/fixtures.js';
import { MemoryObjectStore } from '../helpers/memory-store.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const ORIGIN = 'http://localhost:5173';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const log = pino({ level: 'silent' });
const NO_LIMIT = { hit: async () => ({ count: 0, resetMs: 60_000 }) };
let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express, productId: number;
let ADMIN: { token: string }, STAFF: { token: string };
const invalidated: string[] = [];
const missingAudit: string[] = [];

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  await seedShipping(prisma); await seedGeo(prisma); await seedSettings(prisma);
  productId = (await tx(prisma, (t) => catalog(t, [[{ price: 10_000 }]]))).products[0]!.productId;
  const cache = new RedisSessionCache(redis);
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: 'http://localhost:3000', adminUrl: ORIGIN });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log, hasRecentStepUp: async () => true, onMissingAudit: (req) => missingAudit.push(`${req.method} ${req.originalUrl}`) });
  const media = new MediaService(prisma, { store: new MemoryObjectStore(), buckets: { PUBLIC: 'pub', PRIVATE: 'priv' }, publicBaseUrl: 'https://cdn.test' }, async () => {});
  registerCmsRoutes(admin, new CmsService(prisma, (m) => media.view(m), { get: (_n, load) => load(), invalidate: async (n) => { invalidated.push(n); } }, (k) => `https://cdn.test/${k}`), media);
  app = createApp({ version: 't', origins: { storefront: [], admin: [ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} }, routes: [adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }), admin.router] });
  [ADMIN, STAFF] = [await staff('ADMIN'), await staff('STAFF')];
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });
beforeEach(() => { missingAudit.length = 0; invalidated.length = 0; });

async function staff(role: UserRole) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  await prisma.user.create({ data: { email, name: role, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword('cms-password-1') } });
  return { token: (await request(app).post('/v1/admin/auth/login').set('Origin', ORIGIN).send({ email, password: 'cms-password-1' })).body.accessToken as string };
}
const call = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, body?: object, who = ADMIN) => {
  const r = request(app)[method](`/v1/admin${path}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${who.token}`);
  return body ? r.send(body) : r;
};
const fields = (res: request.Response) => Object.fromEntries((res.body.error?.details ?? []).map((d: { path: string; message: string }) => [d.path, d.message]));
const media = (o: { kind?: 'IMAGE' | 'VIDEO'; visibility?: 'PUBLIC' | 'PRIVATE'; scope?: string; status?: 'READY' | 'REJECTED' } = {}) => prisma.media.create({ data: {
  key: `${(o.visibility ?? 'PUBLIC').toLowerCase()}/x/${uniq()}.${o.kind === 'VIDEO' ? 'mp4' : 'jpg'}`, visibility: o.visibility ?? 'PUBLIC', kind: o.kind ?? 'IMAGE', declaredMime: o.kind === 'VIDEO' ? 'video/mp4' : 'image/jpeg', declaredSize: 10,
  ownerScope: o.scope ?? 'admin', status: o.status ?? 'READY', width: 1600, height: 900, renditions: o.kind === 'VIDEO' ? undefined : { 320: `x/${uniq()}/w320.webp`, 1600: `x/${uniq()}/w1600.webp` } } }).then((m) => m.id);

describe('slides', () => {
  it('create (image checked, button pair, dates), list with the live flag, update, reorder, delete; STAFF 403; audited', async () => {
    const img = await media();
    expect((await call('get', '/home-slides', undefined, STAFF)).status).toBe(403);
    expect(fields(await call('post', '/home-slides', {}))).toEqual({ mediaId: 'Choose an image' });
    expect(fields(await call('post', '/home-slides', { mediaId: img, ctaText: 'Shop' }))).toEqual({ ctaLink: 'A button needs both its text and its link' });
    expect(fields(await call('post', '/home-slides', { mediaId: img, ctaText: 'Shop', ctaLink: 'javascript:alert(1)' }))).toEqual({ ctaLink: 'Use a link on this site (starting with /) or a full https:// address' });
    expect(fields(await call('post', '/home-slides', { mediaId: img, startsAt: '2026-10-10T00:00:00+05:30', endsAt: '2026-10-09T00:00:00+05:30' }))).toEqual({ endsAt: 'Use an end after the start' });
    expect(fields(await call('post', '/home-slides', { mediaId: await media({ visibility: 'PRIVATE', scope: 'import' }) }))).toEqual({ mediaId: 'Choose an uploaded image' });
    const a = await call('post', '/home-slides', { mediaId: img, heading: 'Resin art season', ctaText: 'Shop now', ctaLink: '/shop' });
    expect(a.status).toBe(201);
    const b = await call('post', '/home-slides', { mediaId: await media(), startsAt: '2099-01-01T00:00:00Z' });
    const list = b.body.data as { id: number; live: boolean; sortOrder: number; media: { url: string } }[];
    expect(list.map((s) => [s.id, s.live, s.sortOrder])).toEqual([[a.body.id, true, 0], [b.body.id, false, 1]]);
    expect(list[0]!.media.url).toMatch(/^https:\/\/cdn\.test\/.*w320\.webp$/);
    expect((await call('put', `/home-slides/${a.body.id}`, { mediaId: img, heading: 'Monsoon offers', isActive: false })).body.data[0]).toMatchObject({ heading: 'Monsoon offers', isActive: false, live: false });
    expect((await call('patch', '/home-slides/reorder', { ids: [b.body.id, a.body.id] })).body.data.map((s: { id: number }) => s.id)).toEqual([b.body.id, a.body.id]);
    expect((await call('patch', '/home-slides/reorder', { ids: [b.body.id, 999999] })).status).toBe(422);
    expect((await call('delete', `/home-slides/${a.body.id}`)).body.data.map((s: { id: number }) => s.id)).toEqual([b.body.id]);
    expect((await call('delete', `/home-slides/${a.body.id}`)).status).toBe(404);
    expect((await prisma.auditLog.findMany({ where: { entity: 'home_slide' }, orderBy: { id: 'asc' } })).map((x) => x.action)).toEqual(['home_slide.create', 'home_slide.create', 'home_slide.update', 'home_slide.reorder', 'home_slide.delete']);
    expect(missingAudit).toEqual([]);
  });
});

describe('reels, testimonials, FAQs', () => {
  it('reels need a video, an existing product and an Instagram link', async () => {
    const video = await media({ kind: 'VIDEO' });
    expect(fields(await call('post', '/reels', { videoMediaId: await media() }))).toEqual({ videoMediaId: 'Choose an uploaded video' });
    expect(fields(await call('post', '/reels', { videoMediaId: video, productId: 999999 }))).toEqual({ productId: 'This product no longer exists' });
    expect(fields(await call('post', '/reels', { videoMediaId: video, instagramUrl: 'https://example.com/reel' }))).toEqual({ instagramUrl: 'Use an instagram.com link' });
    const r = await call('post', '/reels', { videoMediaId: video, productId, title: 'Pouring a river table', instagramUrl: 'https://www.instagram.com/reel/abc/' });
    expect(r.body.data[0]).toMatchObject({ title: 'Pouring a river table', product: { id: productId }, video: { url: expect.stringMatching(/\.mp4$/) } });
  });

  it('testimonials: rating 1 and 5 ok, 0 and 6 not; quote at least 10 characters', async () => {
    const base = { name: 'Asha Menon', quote: 'Beautiful finish and fast delivery' };
    expect((await call('post', '/testimonials', { ...base, rating: 1 })).status).toBe(201);
    expect((await call('post', '/testimonials', { ...base, rating: 5 })).status).toBe(201);
    expect(fields(await call('post', '/testimonials', { ...base, rating: 6 }))).toEqual({ rating: 'Use 1 to 5 stars' });
    expect(fields(await call('post', '/testimonials', { ...base, rating: 0 }))).toEqual({ rating: 'Use 1 to 5 stars' });
    expect(fields(await call('post', '/testimonials', { ...base, quote: 'Too short', rating: 4 }))).toEqual({ quote: 'Enter what they said (at least 10 characters)' });
  });

  it('FAQs: ordered within their group; a reorder across groups is refused', async () => {
    const q = (group: string, question: string) => call('post', '/faqs', { group, question, answer: 'Within 4 to 7 days across India.' });
    const a = (await q('SHIPPING', 'How long does delivery take?')).body.id;
    const b = (await q('SHIPPING', 'Do you ship abroad?')).body.id;
    const c = (await q('ORDERS', 'Can I change my order?')).body.id;
    expect((await call('get', '/faqs')).body.data.filter((f: { group: string }) => f.group === 'SHIPPING').map((f: { sortOrder: number }) => f.sortOrder)).toEqual([0, 1]);
    expect((await call('patch', '/faqs/reorder', { ids: [b, a] })).status).toBe(200);
    expect(fields(await call('patch', '/faqs/reorder', { ids: [a, c] }))).toEqual({ ids: 'Reorder FAQs within one group at a time' });
    expect(fields(await call('patch', '/faqs/reorder', { ids: [a, a] }))).toEqual({ ids: 'An item is listed twice' });
  });
});

describe('pages', () => {
  it('rich text cleaned; unique address; the footer’s pages keep their address and can only be unpublished', async () => {
    const p = await call('post', '/pages', { slug: 'about', title: 'About ArtQ', content: '<p>Handcrafted <strong>resin</strong> art.</p><script>alert(1)</script><img src=x onerror=alert(1)>' });
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({ slug: 'about', content: '<p>Handcrafted <strong>resin</strong> art.</p>', isPublished: true, updatedBy: 'ADMIN' });
    expect(fields(await call('post', '/pages', { slug: 'about', title: 'Again', content: '<p>x</p>' }))).toEqual({ slug: 'Another page already uses this address' });
    expect(fields(await call('post', '/pages', { slug: 'Bad Slug', title: 'x1', content: '<p>x</p>' }))).toEqual({ slug: 'Use lowercase letters, digits and single dashes' });
    expect(fields(await call('post', '/pages', { slug: 'empty', title: 'Empty', content: '<p> </p><script>x</script>' }))).toEqual({ content: 'Write the page' });
    expect(fields(await call('put', `/pages/${p.body.id}`, { slug: 'about-us', title: 'About', content: '<p>x</p>' }))).toEqual({ slug: 'This page’s address is used by the site footer; it can’t change' });
    expect((await call('delete', `/pages/${p.body.id}`)).body.error.code).toBe('UNPUBLISH_INSTEAD');
    expect((await call('put', `/pages/${p.body.id}`, { slug: 'about', title: 'About', content: '<p>x</p>', isPublished: false })).body.isPublished).toBe(false);
    const extra = await call('post', '/pages', { slug: 'care-guide', title: 'Resin care guide', content: '<p>Keep away from direct sun.</p>', metaDescription: 'How to look after resin art' });
    expect((await call('get', '/pages')).body.data.map((x: { slug: string }) => x.slug)).toEqual(['about', 'care-guide']);
    expect((await call('delete', `/pages/${extra.body.id}`)).status).toBe(204);
    expect((await call('get', '/pages/999999')).status).toBe(404);
    expect(missingAudit).toEqual([]);
  });
});

describe('home settings', () => {
  it('the shared rules per key; saved values drop the public settings cache; STAFF 403', async () => {
    expect(fields(await call('put', '/settings/ANNOUNCEMENT_BAR', { enabled: true, messages: [] }))).toEqual({ messages: 'Add a message, or turn the bar off' });
    expect(fields(await call('put', '/settings/ANNOUNCEMENT_BAR', { enabled: true, messages: ['x'.repeat(121)] }))).toEqual({ 'messages.0': 'Use at most 120 characters' });
    const ok = await call('put', '/settings/ANNOUNCEMENT_BAR', { enabled: true, messages: ['Free shipping above ₹999', 'x'.repeat(120)] });
    expect(ok.body.ANNOUNCEMENT_BAR).toEqual({ enabled: true, messages: ['Free shipping above ₹999', 'x'.repeat(120)] });
    expect(invalidated).toEqual(['publicSettings']);
    expect(fields(await call('put', '/settings/HOME_SECTIONS', { order: ['hero'], hidden: [] }))).toEqual({ order: 'List every section once' });
    expect(fields(await call('put', '/settings/HOME_SECTIONS', { order: ['hero', 'types', 'new-arrivals', 'reels', 'trending', 'techniques', 'testimonials', 'instagram'], hidden: ['hero'] }))).toEqual({ hidden: 'The hero can’t be hidden' });
    expect((await call('put', '/settings/HERO', { slideIntervalMs: 2000 })).status).toBe(200);
    expect(fields(await call('put', '/settings/HERO', { slideIntervalMs: 1999 }))).toEqual({ slideIntervalMs: 'Use at least 2 seconds' });
    expect(fields(await call('put', '/settings/INSTAGRAM_MOMENTS', { enabled: true, handle: '' }))).toEqual({ handle: 'Enter the handle, or turn the section off' });
    expect(fields(await call('put', '/settings/SOCIAL', { instagram: 'http://insecure.example', facebook: null, youtube: null, whatsapp: null }))).toEqual({ instagram: 'Use a full https:// link' });
    expect((await call('put', '/settings/STORE_INFO', {})).status).toBe(404);              // not a content setting (6.5)
    expect((await call('put', '/settings/HERO', { slideIntervalMs: 5000 }, STAFF)).status).toBe(403);
    expect((await call('get', '/cms/settings')).body.HERO).toEqual({ slideIntervalMs: 2000 });
    expect(await prisma.auditLog.count({ where: { action: 'setting.update' } })).toBe(2);
  });
});

describe('messages', () => {
  it('inbox filters; detail with private attachments as short links; status and note; 404', async () => {
    const photo = await media({ visibility: 'PRIVATE', scope: 'custom-work:abc' });
    const c = await prisma.contactMessage.create({ data: { kind: 'CONTACT', name: 'Asha', email: 'asha@example.com', subject: 'Order question', message: 'Where is my parcel?', orderNumber: 'AQ10234' } });
    const w = await prisma.contactMessage.create({ data: { kind: 'CUSTOM_WORK', name: 'Ravi', email: 'ravi@example.com', message: 'A wedding garland preserved in a teak frame', details: { size: 'A3', wood: 'Teak' }, attachments: { create: [{ mediaId: photo }] } } });
    await prisma.contactMessage.create({ data: { name: 'Old', email: 'old@example.com', message: 'Thanks!', status: 'CLOSED' } });
    expect((await call('get', '/messages?open=1')).body.data.map((m: { id: number }) => m.id)).toEqual([w.id, c.id]);
    expect((await call('get', '/messages?kind=CUSTOM_WORK')).body.data).toEqual([expect.objectContaining({ id: w.id, attachments: 1 })]);
    expect((await call('get', '/messages?q=aq10234')).body.data.map((m: { id: number }) => m.id)).toEqual([c.id]);
    const d = (await call('get', `/messages/${w.id}`)).body;
    expect(d).toMatchObject({ details: { size: 'A3', wood: 'Teak' }, files: [{ id: photo, url: expect.stringMatching(/exp=300/), thumbUrl: expect.stringMatching(/w320\.webp/) }] });
    expect(fields(await call('patch', `/messages/${c.id}`, {}))).toEqual({ '': 'Nothing to change' });
    const p = await call('patch', `/messages/${c.id}`, { status: 'REPLIED', adminNote: 'Replied with the tracking link' });
    expect(p.body).toMatchObject({ status: 'REPLIED', adminNote: 'Replied with the tracking link' });
    expect((await call('get', '/messages/999999')).status).toBe(404);
    expect((await call('get', '/messages', undefined, STAFF)).status).toBe(403);
    expect(missingAudit).toEqual([]);
  });
});
