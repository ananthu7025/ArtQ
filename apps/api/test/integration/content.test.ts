// Task 6.2 on real PostgreSQL + Redis: storefront content. Pages (published only, public cache headers, unknown → 404),
// FAQs (active only, grouped in order, empty groups left out), the contact form (saved to the inbox, acknowledgement
// and staff emails, field rules, rate limit), custom work (photos uploaded by this visitor only: a guest's cart cookie
// or the signed-in customer; processed, unattached, at most 4), and that a photo can't be reused or stolen.
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { authRouter } from '../../src/auth/routes.js';
import { AuthService, DEFAULT_AUTH_TIMINGS } from '../../src/auth/service.js';
import { RedisSessionCache } from '../../src/auth/session-cache.js';
import { contentRouter } from '../../src/content/routes.js';
import { processEmailDelivery } from '../../src/email/consumer.js';
import { MemoryTransport } from '../../src/email/transport.js';
import { hashPassword } from '../../src/lib/password.js';
import { MediaService } from '../../src/media/service.js';
import { RedisRateLimiter } from '../../src/middleware/rateLimit.js';
import { seedGeo, seedSettings, seedShipping } from '../../src/seed/steps.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { uniq } from '../helpers/fixtures.js';
import { MemoryObjectStore } from '../helpers/memory-store.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const WEB = 'http://localhost:3000';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const log = pino({ level: 'silent' });
const COOKIE = '__Secure-aq_cart_test';
let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express;

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  await seedShipping(prisma); await seedGeo(prisma); await seedSettings(prisma);
  const notify = { adminEmails: ['owner@artq.in'], dailySummary: true, lowStockEmail: true };
  await prisma.setting.upsert({ where: { key: 'NOTIFY' }, update: { value: notify }, create: { key: 'NOTIFY', value: notify } });
  const cache = new RedisSessionCache(redis);
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: WEB, adminUrl: 'http://localhost:5173' });
  const store = new MemoryObjectStore();
  const media = new MediaService(prisma, { store, buckets: { PUBLIC: 'pub', PRIVATE: 'priv' }, publicBaseUrl: 'https://cdn.test' }, async () => {});
  const deps = { prisma, cache, jwt: JWT };
  const limiter = new RedisRateLimiter(redis);
  app = createApp({ version: 't', origins: { storefront: [WEB], admin: [] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [authRouter({ ...deps, service, env: 'test', refreshMaxAgeS: DEFAULT_AUTH_TIMINGS.refreshIdleS, limiter: { hit: async () => ({ count: 0, resetMs: 60_000 }) } }),
      contentRouter({ ...deps, env: 'test', log, media, mediaUrl: (k) => `https://cdn.test/${k}`, limiter })] });
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });

/** Each test speaks from its own IP so the 5-a-minute form limit only bites where it is tested. */
const from = (ip: string) => ({
  get: (path: string) => request(app).get(`/v1${path}`).set('Origin', WEB).set('X-Forwarded-For', ip),
  post: (path: string, body: object, o: { cookie?: string; bearer?: string } = {}) => {
    let r = request(app).post(`/v1${path}`).set('Origin', WEB).set('X-Forwarded-For', ip);
    if (o.cookie) r = r.set('Cookie', `${COOKIE}=${o.cookie}`);
    if (o.bearer) r = r.set('Authorization', `Bearer ${o.bearer}`);
    return r.send(body);
  },
});
let ipN = 0;
/** A fresh IP: for calls where the form limit is not what is tested. */
const fresh = () => from(`10.9.${Math.floor(++ipN / 250)}.${ipN % 250}`);
const fields = (res: request.Response) => Object.fromEntries((res.body.error?.details ?? []).map((d: { path: string; message: string }) => [d.path, d.message]));
const cookieOf = (res: request.Response) => /aq_cart_test=([^;]+)/.exec(String(res.headers['set-cookie']))?.[1];
async function deliveries(type: string, id: number) {
  return prisma.$queryRaw<{ id: bigint; consumer: string }[]>`SELECT d.id, d.consumer FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id WHERE e.event_type = ${type} AND e.aggregate_id = ${String(id)} ORDER BY d.consumer`;
}

describe('pages and FAQs', () => {
  it('a published page is public and cacheable; drafts and unknown slugs → 404', async () => {
    await prisma.cmsPage.create({ data: { slug: 'about', title: 'About ArtQ', content: '<p>Handcrafted resin art.</p>', metaDescription: 'Who we are' } });
    await prisma.cmsPage.create({ data: { slug: 'draft-page', title: 'Draft', content: '<p>x</p>', isPublished: false } });
    const res = await from('10.0.0.1').get('/pages/about');
    expect(res.body).toMatchObject({ slug: 'about', title: 'About ArtQ', content: '<p>Handcrafted resin art.</p>', metaDescription: 'Who we are' });
    expect(res.headers['cache-control']).toMatch(/public/);
    expect((await from('10.0.0.1').get('/pages/draft-page')).status).toBe(404);
    expect((await from('10.0.0.1').get('/pages/nope')).status).toBe(404);
    expect((await from('10.0.0.1').get('/pages/Bad_Slug')).status).toBe(400);
  });
  it('FAQs: active only, grouped in order, empty groups left out', async () => {
    await prisma.faq.createMany({ data: [
      { group: 'SHIPPING', question: 'Second?', answer: 'B', sortOrder: 1 }, { group: 'SHIPPING', question: 'First?', answer: 'A', sortOrder: 0 },
      { group: 'ORDERS', question: 'Hidden?', answer: 'x', isActive: false }, { group: 'RETURNS', question: 'Return?', answer: 'Within 48 h' },
    ] });
    expect((await from('10.0.0.2').get('/faqs')).body).toEqual({ groups: [
      { group: 'SHIPPING', label: 'Shipping', items: [{ question: 'First?', answer: 'A' }, { question: 'Second?', answer: 'B' }] },
      { group: 'RETURNS', label: 'Returns & refunds', items: [{ question: 'Return?', answer: 'Within 48 h' }] },
    ] });
  });
});

describe('contact', () => {
  it('saved to the inbox; the visitor and staff are emailed; field rules; 5 a minute per IP', async () => {
    const c = from('10.0.1.1');
    expect(Object.keys(fields(await c.post('/contact', {})))).toEqual(expect.arrayContaining(['name', 'email', 'subject', 'message']));
    expect(fields(await c.post('/contact', { name: 'Asha', email: 'asha@example.com', subject: 'Order', message: 'Where is my parcel?', orderNumber: 'X123' }))).toEqual({ orderNumber: 'Enter an order number like AQ10234' });
    const ok = await c.post('/contact', { name: 'Asha Menon', email: 'asha@example.com', subject: 'Order question', message: 'Where is my parcel, please?', orderNumber: 'aq10234', phone: '' });
    expect(ok.status).toBe(201);
    expect(await prisma.contactMessage.findUniqueOrThrow({ where: { id: ok.body.id } })).toMatchObject({ kind: 'CONTACT', orderNumber: 'AQ10234', phone: null, status: 'NEW' });
    const ds = await deliveries('message.received', ok.body.id);
    expect(ds.map((x) => x.consumer)).toEqual(['email.admin', 'email.customer']);
    const mail = new MemoryTransport();
    for (const x of ds) await processEmailDelivery({ prisma, transport: mail, from: 'x@artq.in', log }, x.consumer as 'email.admin' | 'email.customer', Number(x.id));
    expect(mail.sent.map((m) => [m.to, m.subject])).toEqual([['owner@artq.in', '[ArtQ] Contact: Order question'], ['asha@example.com', 'We’ve received your message']]);
    // The first two refusals and the message count against this IP: two more pass, the sixth is refused.
    expect((await c.post('/contact', { name: 'Asha', email: 'a@b.in', subject: 'Hello', message: 'Just saying hello!' })).status).toBe(201);
    expect((await c.post('/contact', { name: 'Asha', email: 'a@b.in', subject: 'Hello', message: 'Just saying hello!' })).status).toBe(201);
    expect((await c.post('/contact', { name: 'Asha', email: 'a@b.in', subject: 'Hello', message: 'Just saying hello!' })).body.error.code).toBe('RATE_LIMITED');
  });
});

describe('custom work', () => {
  const body = { name: 'Ravi Kumar', email: 'ravi@example.com', phone: '+919847012345', details: { size: 'A3', wood: 'Teak', quantity: 1, budget: 4500, neededBy: '2026-12-01' }, message: 'Preserve our wedding garland in a teak frame.' };
  const photo = (scope: string, uploadedBy: number | null, status: 'READY' | 'PROCESSING' = 'READY') => prisma.media.create({ data: { key: `private/custom-work/${uniq()}.jpg`, visibility: 'PRIVATE', kind: 'IMAGE', declaredMime: 'image/jpeg', declaredSize: 10, ownerScope: scope, uploadedBy, status } }).then((m) => m.id);

  it('a guest: presign creates the cart cookie (scope); own processed photos attach once; others’ or unprocessed refused', async () => {
    const g = from('10.0.2.1');
    const pre = await g.post('/uploads/presign', { filename: 'garland.jpg', contentType: 'image/jpeg', size: 1000 });
    expect(pre.status).toBe(201);
    const cookie = cookieOf(pre)!;
    const m = await prisma.media.findUniqueOrThrow({ where: { id: pre.body.media.id } });
    expect([m.visibility, m.uploadedBy, m.ownerScope.startsWith('custom-work:')]).toEqual(['PRIVATE', null, true]);
    expect((await g.post('/uploads/presign', { filename: 'a.pdf', contentType: 'application/pdf', size: 10 }, { cookie })).body.error.code).toBe('MEDIA_TYPE_NOT_ALLOWED');
    await prisma.media.update({ where: { id: m.id }, data: { status: 'PROCESSING' } });
    expect(fields(await fresh().post('/custom-work', { ...body, attachmentMediaIds: [m.id] }, { cookie }))).toEqual({ attachmentMediaIds: 'A photo is still being processed. Wait a moment and send again.' });
    await prisma.media.update({ where: { id: m.id }, data: { status: 'READY' } });
    const someoneElse = await photo('custom-work:other', null);
    expect(fields(await fresh().post('/custom-work', { ...body, attachmentMediaIds: [someoneElse] }, { cookie }))).toEqual({ attachmentMediaIds: 'A photo is missing, still being processed, or already sent. Upload it again.' });
    expect(fields(await fresh().post('/custom-work', { ...body, attachmentMediaIds: [m.id] }))).toEqual({ attachmentMediaIds: 'Upload the photos again' });   // no cookie
    const ok = await fresh().post('/custom-work', { ...body, attachmentMediaIds: [m.id] }, { cookie });
    expect(ok.status).toBe(201);
    const saved = await prisma.contactMessage.findUniqueOrThrow({ where: { id: ok.body.id }, include: { attachments: true } });
    expect(saved).toMatchObject({ kind: 'CUSTOM_WORK', details: body.details, attachments: [{ mediaId: m.id }] });
    expect((await prisma.media.findUniqueOrThrow({ where: { id: m.id } })).claimedAt).not.toBeNull();
    expect(fields(await from('10.0.2.2').post('/custom-work', { ...body, attachmentMediaIds: [m.id] }, { cookie }))).toEqual({ attachmentMediaIds: 'A photo is missing, still being processed, or already sent. Upload it again.' });
  });

  it('a signed-in customer uploads as themself; limits on the fields', async () => {
    const email = `c${uniq()}@example.com`;
    await prisma.user.create({ data: { email, name: 'Meera', role: 'CUSTOMER', status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword('content-password-1') } });
    const token = (await request(app).post('/v1/auth/login').set('Origin', WEB).send({ email, password: 'content-password-1' })).body.accessToken as string;
    const c = from('10.0.3.1');
    const pre = await c.post('/uploads/presign', { filename: 'a.jpg', contentType: 'image/jpeg', size: 10 }, { bearer: token });
    expect(cookieOf(pre)).toBeUndefined();
    const m = await prisma.media.findUniqueOrThrow({ where: { id: pre.body.media.id } });
    expect(m.uploadedBy).not.toBeNull();
    await prisma.media.update({ where: { id: m.id }, data: { status: 'READY' } });
    expect(fields(await c.post('/custom-work', { ...body, details: { ...body.details, budget: 99 }, attachmentMediaIds: [m.id] }, { bearer: token }))).toEqual({ 'details.budget': 'At least ₹100' });
    expect((await c.post('/custom-work', { ...body, attachmentMediaIds: [m.id] }, { bearer: token })).status).toBe(201);
    const c2 = from('10.0.3.2');
    expect(fields(await c2.post('/custom-work', { ...body, attachmentMediaIds: [1, 2, 3, 4, 5] }))).toEqual({ attachmentMediaIds: 'At most 4 photos' });
    expect(fields(await c2.post('/custom-work', { ...body, phone: '' }))).toHaveProperty('phone');
    expect((await c2.post('/custom-work', body)).status).toBe(201);                           // photos are optional
  });
});
