// Task 3.1: the public endpoints the storefront layout needs (api.md §3.1–§3.2): navigation, public settings,
// newsletter sign-up. Real PostgreSQL and Redis.
import { DEFAULT_SETTINGS } from '@artq/shared';
import { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { RedisRateLimiter, type RateLimiter } from '../../src/middleware/rateLimit.js';
import { seedSettings } from '../../src/seed/steps.js';
import { PUBLIC_CACHE, storefrontRouter } from '../../src/storefront/routes.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { uniq } from '../helpers/fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const ORIGIN = 'http://localhost:3000';
let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis;
beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });

function build(o: { db?: PrismaClient; limiter?: RateLimiter; invalid?: string[]; limiterErrors?: unknown[] } = {}): Express {
  const limiter = o.limiter ?? new RedisRateLimiter(redis);
  const onRateLimitError = (e: unknown) => { o.limiterErrors?.push(e); };
  return createApp({
    version: 't', origins: { storefront: [ORIGIN], admin: ['http://localhost:5173'] }, readiness: { database: async () => {}, redis: async () => {} },
    rateLimiter: limiter, onRateLimitError,
    routes: [storefrontRouter({ prisma: o.db ?? prisma, limiter, onRateLimitError, onInvalidSetting: (k) => o.invalid?.push(k) })],
  });
}
const ip = () => `203.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const subscribe = (app: Express, body: unknown, from = ip(), origin: string | null = ORIGIN) => {
  let r = request(app).post('/v1/newsletter/subscribe').set('Content-Type', 'application/json').set('X-Forwarded-For', from);
  if (origin) r = r.set('Origin', origin);
  return r.send(body as object);
};

async function type(o: { name: string; sort?: number; active?: boolean; menu?: boolean; tile?: string | null }) {
  return prisma.productType.create({ data: { name: o.name, slug: `${o.name.toLowerCase().replace(/\W+/g, '-')}-${uniq()}`, sortOrder: o.sort ?? 0, isActive: o.active ?? true, showInMenu: o.menu ?? true, tileLinkUrl: o.tile ?? null } });
}
async function category(typeId: number, name: string, o: { sort?: number; active?: boolean } = {}) {
  return prisma.category.create({ data: { typeId, name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${uniq()}`, sortOrder: o.sort ?? 0, isActive: o.active ?? true } });
}

describe('GET /v1/navigation', () => {
  beforeEach(async () => { await prisma.category.deleteMany(); await prisma.productType.deleteMany(); });

  it('no types yet → an empty menu (not an error)', async () => {
    const res = await request(build()).get('/v1/navigation');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ types: [] });
  });

  it('active menu types in admin order with their active categories in order; hidden, inactive and off-menu ones left out', async () => {
    const pigments = await type({ name: 'Pigments', sort: 2 });
    const resins = await type({ name: 'Resins', sort: 1 });
    const frames = await type({ name: 'Frames', sort: 2 });          // same sort as Pigments: created later → after it
    await type({ name: 'Old Stuff', active: false });
    await type({ name: 'Hidden From Menu', menu: false });
    const uv = await type({ name: 'UV Resin', sort: 3, tile: '/category/uv-resin' });
    const mica = await category(pigments.id, 'Mica Powder', { sort: 2 });
    const inks = await category(pigments.id, 'Alcohol Inks', { sort: 1 });
    await category(pigments.id, 'Discontinued', { active: false });
    const res = await request(build()).get('/v1/navigation');
    expect(res.body.types.map((t: { name: string }) => t.name)).toEqual(['Resins', 'Pigments', 'Frames', 'UV Resin']);
    expect(res.body.types[1]).toEqual({ id: pigments.id, name: 'Pigments', slug: pigments.slug, href: `/type/${pigments.slug}`, categories: [
      { id: inks.id, name: 'Alcohol Inks', slug: inks.slug }, { id: mica.id, name: 'Mica Powder', slug: mica.slug },
    ] });
    expect(res.body.types[0]).toMatchObject({ id: resins.id, categories: [] });
    expect(res.body.types[2].id).toBe(frames.id);
    expect(res.body.types[3]).toMatchObject({ id: uv.id, href: '/category/uv-resin' });      // the tile link override
  });

  it('is publicly cacheable for 60 s and never sets a cookie, even when the request carries cookies', async () => {
    const res = await request(build()).get('/v1/navigation').set('Cookie', 'aq_cart=abc; __Secure-aq_rt=xyz');
    expect(res.headers['cache-control']).toBe(PUBLIC_CACHE);
    expect(res.headers['cache-control']).toBe('public, max-age=0, s-maxage=60, stale-while-revalidate=60');
    expect(res.headers.vary).toContain('Accept-Encoding');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('database down → 500 with the standard error body, not cached', async () => {
    const dead = new PrismaClient({ datasourceUrl: 'postgresql://artq:artq@127.0.0.1:1/none?connect_timeout=1' });
    const res = await request(build({ db: dead })).get('/v1/navigation');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.body)).not.toContain('127.0.0.1');
    await dead.$disconnect();
  });
});

describe('GET /v1/settings/public', () => {
  beforeEach(async () => { await prisma.setting.deleteMany(); });

  it('before seeding: the launch defaults (announcement, free-shipping threshold, COD limits)', async () => {
    const res = await request(build()).get('/v1/settings/public');
    expect(res.status).toBe(200);
    expect(res.body.announcement).toEqual({ enabled: true, messages: ['Shipping all over India', 'Free shipping on orders above ₹1000'] });
    expect(res.body.shipping).toEqual({ freeThreshold: 100_000, estimatedDays: { min: 4, max: 7 } });
    expect(res.body.payment).toEqual({ codEnabled: true, codFee: 4000, codMin: 20_000, codMax: 500_000 });
    expect(res.body.store).toEqual({ name: 'ArtQ', phone: null, email: null, whatsapp: null });
    expect(res.headers['cache-control']).toBe(PUBLIC_CACHE);
  });

  it('serves what the owner stored; GSTIN, legal name, address and private settings never leave the API', async () => {
    await seedSettings(prisma);
    await prisma.setting.update({ where: { key: 'STORE_INFO' }, data: { value: { ...DEFAULT_SETTINGS.STORE_INFO, gstin: '32ABCDE1234F1Z5', legalName: 'ArtQ Crafts LLP', address: '12 MG Road, Kochi', phone: '+91 98470 12345', whatsapp: '+91 98470 12345' } } });
    await prisma.setting.update({ where: { key: 'ANNOUNCEMENT_BAR' }, data: { value: { enabled: true, messages: ['Diwali sale: 10% off pigments'] } } });
    const res = await request(build()).get('/v1/settings/public');
    expect(res.body.store).toEqual({ name: 'ArtQ', phone: '+91 98470 12345', email: null, whatsapp: '+91 98470 12345' });
    expect(res.body.announcement.messages).toEqual(['Diwali sale: 10% off pigments']);
    const text = JSON.stringify(res.body);
    for (const secret of ['32ABCDE1234F1Z5', 'ArtQ Crafts LLP', 'MG Road', 'adminEmails', 'shippingTaxRule', 'packagingWeightG', 'autoRefundExcessCapture']) expect(text).not.toContain(secret);
  });

  it('the WhatsApp number falls back to the social setting when the store one is empty', async () => {
    await seedSettings(prisma);
    await prisma.setting.update({ where: { key: 'SOCIAL' }, data: { value: { ...DEFAULT_SETTINGS.SOCIAL, whatsapp: '919847012345', instagram: 'https://instagram.com/artq' } } });
    const res = await request(build()).get('/v1/settings/public');
    expect(res.body.store.whatsapp).toBe('919847012345');
    expect(res.body.social.instagram).toBe('https://instagram.com/artq');
  });

  it('a broken stored value falls back to the default and is reported; a public key stored as private is not served', async () => {
    await seedSettings(prisma);
    await prisma.setting.update({ where: { key: 'ANNOUNCEMENT_BAR' }, data: { value: { enabled: 'yes', messages: 'oops' } } });
    await prisma.setting.update({ where: { key: 'SHIPPING' }, data: { isPublic: false, value: { ...DEFAULT_SETTINGS.SHIPPING, freeThreshold: 1 } } });
    const invalid: string[] = [];
    const res = await request(build({ invalid })).get('/v1/settings/public');
    expect(res.status).toBe(200);
    expect(res.body.announcement).toEqual(DEFAULT_SETTINGS.ANNOUNCEMENT_BAR);
    expect(invalid).toEqual(['ANNOUNCEMENT_BAR']);
    expect(res.body.shipping.freeThreshold).toBe(100_000);
  });

  it('a disabled bar with no messages (0) and the maximum of 5 messages both come through as stored', async () => {
    await seedSettings(prisma);
    await prisma.setting.update({ where: { key: 'ANNOUNCEMENT_BAR' }, data: { value: { enabled: false, messages: [] } } });
    expect((await request(build()).get('/v1/settings/public')).body.announcement).toEqual({ enabled: false, messages: [] });
    const five = ['a', 'b', 'c', 'd', 'e'].map((x) => `${x}`.repeat(120));
    await prisma.setting.update({ where: { key: 'ANNOUNCEMENT_BAR' }, data: { value: { enabled: true, messages: five } } });
    expect((await request(build()).get('/v1/settings/public')).body.announcement.messages).toEqual(five);
  });
});

describe('POST /v1/newsletter/subscribe', () => {
  it('new address → 201 SUBSCRIBED; the same address again (any case, spaces) → 200 ALREADY_SUBSCRIBED; one row', async () => {
    const app = build();
    const email = `fan-${uniq()}@example.com`;
    const first = await subscribe(app, { email });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ status: 'SUBSCRIBED' });
    expect(first.headers['cache-control']).toBe('no-store');
    const again = await subscribe(app, { email: `  ${email.toUpperCase()} `, source: 'footer' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ status: 'ALREADY_SUBSCRIBED' });
    const rows = await prisma.newsletterSubscriber.findMany({ where: { email } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'SUBSCRIBED', source: 'footer' });
    expect(rows[0]!.unsubscribeToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it('someone who unsubscribed and signs up again → 201, subscribed again, same unsubscribe token', async () => {
    const email = `back-${uniq()}@example.com`;
    await subscribe(build(), { email });
    const before = await prisma.newsletterSubscriber.update({ where: { email }, data: { status: 'UNSUBSCRIBED', unsubscribedAt: new Date() } });
    const res = await subscribe(build(), { email, source: 'checkout' });
    expect(res.status).toBe(201);
    const after = await prisma.newsletterSubscriber.findUniqueOrThrow({ where: { email } });
    expect(after).toMatchObject({ status: 'SUBSCRIBED', unsubscribedAt: null, unsubscribeToken: before.unsubscribeToken });
  });

  it('the same address sent 5 times at once → exactly one 201, the rest 200, one row', async () => {
    const app = build();
    const email = `race-${uniq()}@example.com`;
    const res = await Promise.all(Array.from({ length: 5 }, () => subscribe(app, { email })));
    expect(res.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(await prisma.newsletterSubscriber.count({ where: { email } })).toBe(1);
  });

  it('invalid input → 400 with the shared schema\'s messages on the field; nothing stored', async () => {
    const app = build();
    const cases: [unknown, string, string][] = [
      [{ email: '' }, 'email', 'Enter your email address'],
      [{ email: 'not-an-email' }, 'email', 'Enter a valid email address'],
      [{ email: `${'a'.repeat(150)}@example.com` }, 'email', 'Use at most 160 characters'],
      [{ email: 'x@example.com', source: 'popup' }, 'source', ''],
      [{ email: 'x@example.com', extra: 1 }, '', ''],
      [{}, 'email', ''],
    ];
    const before = await prisma.newsletterSubscriber.count();
    for (const [body, path, message] of cases) {
      const res = await subscribe(app, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      const d = res.body.error.details as { path: string; message: string }[];
      expect(d.some((x) => x.path === path && (!message || x.message === message)), JSON.stringify(d)).toBe(true);
    }
    expect(await prisma.newsletterSubscriber.count()).toBe(before);
  });

  it('exactly 160 characters is accepted', async () => {
    const local = 'b'.repeat(160 - '@example.com'.length);
    expect((await subscribe(build(), { email: `${local}@example.com` })).status).toBe(201);
  });

  it('a request without our Origin → 403 (cross-site form posts are refused)', async () => {
    expect((await subscribe(build(), { email: 'x@example.com' }, ip(), null)).body.error.code).toBe('ORIGIN_REJECTED');
    expect((await subscribe(build(), { email: 'x@example.com' }, ip(), 'https://evil.example')).status).toBe(403);
  });

  it('5 sign-ups per minute per network; the 6th → 429; another network is unaffected', async () => {
    const app = build();
    const from = ip();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await subscribe(app, { email: `rl-${uniq()}@example.com` }, from)).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    expect((await subscribe(app, { email: `rl-${uniq()}@example.com` }, ip())).status).toBe(201);
  });

  it('Redis down: the sign-up still works and the limiter failure is reported', async () => {
    const errors: unknown[] = [];
    const broken: RateLimiter = { hit: async () => { throw new Error('redis unavailable'); } };
    const res = await subscribe(build({ limiter: broken, limiterErrors: errors }), { email: `nored-${uniq()}@example.com` });
    expect(res.status).toBe(201);
    expect(errors.length).toBeGreaterThan(0);
  });
});
