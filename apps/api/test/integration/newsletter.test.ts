// Task 6.3 on real PostgreSQL + Redis: the newsletter. Subscribing sends one welcome email with the unsubscribe link
// (not again when already subscribed; not at all if they unsubscribed first); the link's GET only shows the masked
// address, the POST unsubscribes (twice is harmless); a bad or unknown token is refused; resubscribing works. Admin:
// the list with counts and search, unsubscribe on request (audited), the CSV export (recent password re-check,
// formula-safe cells, unsubscribe links, audited), permissions.
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
import { registerNewsletterRoutes } from '../../src/content/newsletter-admin.js';
import { processEmailDelivery } from '../../src/email/consumer.js';
import { MemoryTransport } from '../../src/email/transport.js';
import { hashPassword } from '../../src/lib/password.js';
import { storefrontRouter } from '../../src/storefront/routes.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { uniq } from '../helpers/fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const WEB = 'http://localhost:3000';
const ORIGIN = 'http://localhost:5173';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const log = pino({ level: 'silent' });
const NO_LIMIT = { hit: async () => ({ count: 0, resetMs: 60_000 }) };
let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express, ADMIN: { token: string }, STAFF: { token: string };
let stepUp = true;
const missingAudit: string[] = [];

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  const cache = new RedisSessionCache(redis);
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: WEB, adminUrl: ORIGIN });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: NO_LIMIT, log, hasRecentStepUp: async () => stepUp, onMissingAudit: (req) => missingAudit.push(`${req.method} ${req.originalUrl}`) });
  registerNewsletterRoutes(admin, prisma, WEB);
  app = createApp({ version: 't', origins: { storefront: [WEB], admin: [ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} },
    routes: [adminAuthRouter({ ...deps, service, env: 'test', limiter: NO_LIMIT }), storefrontRouter({ prisma, mediaUrl: (k) => k }), admin.router] });
  [ADMIN, STAFF] = await Promise.all([staff('ADMIN'), staff('STAFF')]);
}, 180_000);
afterAll(async () => { redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });
beforeEach(() => { stepUp = true; missingAudit.length = 0; });

async function staff(role: UserRole) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  await prisma.user.create({ data: { email, name: role, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword('news-password-1') } });
  return { token: (await request(app).post('/v1/admin/auth/login').set('Origin', ORIGIN).send({ email, password: 'news-password-1' })).body.accessToken as string };
}
const subscribe = (email: string) => request(app).post('/v1/newsletter/subscribe').set('Origin', WEB).send({ email });
const admin = (method: 'get' | 'post', path: string, who = ADMIN) => request(app)[method](`/v1/admin${path}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${who.token}`);
async function welcome(email: string) {
  const mail = new MemoryTransport();
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`SELECT d.id FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id JOIN newsletter_subscribers s ON s.id::text = e.aggregate_id
    WHERE e.event_type = 'newsletter.subscribed' AND s.email = ${email}::citext AND d.status <> 'COMPLETED' ORDER BY d.id`;
  for (const r of rows) await processEmailDelivery({ prisma, transport: mail, from: 'x@artq.in', log, links: { webUrl: WEB, linkSecret: 's', setPasswordTtlS: 60 } }, 'email.customer', Number(r.id));
  return { sent: mail.sent, deliveries: rows.length };
}

describe('subscribe and unsubscribe', () => {
  it('one welcome email with the link; GET shows the masked address only; POST unsubscribes (twice is harmless); resubscribe', async () => {
    const email = `n${uniq()}@example.com`;
    expect((await subscribe(email)).status).toBe(201);
    expect((await subscribe(email.toUpperCase())).body.status).toBe('ALREADY_SUBSCRIBED');
    const w = await welcome(email);
    expect(w.deliveries).toBe(1);
    expect(w.sent[0]!.subject).toBe('You’re subscribed to ArtQ');
    const link = new URL(/http:\/\/localhost:3000\/newsletter\/unsubscribe\?token=[0-9a-f]{32}/.exec(w.sent[0]!.text)![0]);
    const token = link.searchParams.get('token')!;
    const shown = await request(app).get(`/v1/newsletter/unsubscribe?token=${token}`);
    expect(shown.body).toEqual({ email: `${email[0]}***@example.com`, status: 'SUBSCRIBED' });
    expect(shown.headers['cache-control']).toMatch(/no-store/);
    expect((await prisma.newsletterSubscriber.findUniqueOrThrow({ where: { email } })).status).toBe('SUBSCRIBED');   // a GET never changes state
    const un = await request(app).post('/v1/newsletter/unsubscribe').set('Origin', WEB).send({ token });
    expect(un.body.status).toBe('UNSUBSCRIBED');
    expect((await request(app).post('/v1/newsletter/unsubscribe').set('Origin', WEB).send({ token })).body.status).toBe('UNSUBSCRIBED');
    expect((await prisma.newsletterSubscriber.findUniqueOrThrow({ where: { email } })).unsubscribedAt).not.toBeNull();
    expect((await subscribe(email)).status).toBe(201);
    expect((await prisma.newsletterSubscriber.findUniqueOrThrow({ where: { email } })).status).toBe('SUBSCRIBED');
  });

  it('bad and unknown tokens are refused; unsubscribing before the welcome is sent cancels it', async () => {
    expect((await request(app).get('/v1/newsletter/unsubscribe?token=nope')).status).toBe(400);
    expect((await request(app).get(`/v1/newsletter/unsubscribe?token=${'a'.repeat(32)}`)).status).toBe(404);
    expect((await request(app).post('/v1/newsletter/unsubscribe').set('Origin', WEB).send({ token: 'b'.repeat(32) })).status).toBe(404);
    const email = `q${uniq()}@example.com`;
    await subscribe(email);
    const s = await prisma.newsletterSubscriber.findUniqueOrThrow({ where: { email } });
    await request(app).post('/v1/newsletter/unsubscribe').set('Origin', WEB).send({ token: s.unsubscribeToken });
    expect((await welcome(email)).sent).toEqual([]);
  });
});

describe('admin', () => {
  it('list with counts and search; unsubscribe on request (audited); STAFF 403', async () => {
    const email = `list${uniq()}@example.com`;
    await subscribe(email);
    const res = await admin('get', `/newsletter?q=${encodeURIComponent(email)}`);
    expect(res.body.data).toEqual([expect.objectContaining({ email, status: 'SUBSCRIBED', source: 'footer' })]);
    expect(res.body.summary.subscribed).toBeGreaterThanOrEqual(1);
    const id = res.body.data[0].id as number;
    expect((await admin('post', `/newsletter/${id}/unsubscribe`)).body.status).toBe('UNSUBSCRIBED');
    expect((await admin('post', `/newsletter/${id}/unsubscribe`)).body.error.code).toBe('INVALID_TRANSITION');
    expect((await admin('post', '/newsletter/999999/unsubscribe')).status).toBe(404);
    expect((await admin('get', '/newsletter', STAFF)).status).toBe(403);
    expect(await prisma.auditLog.count({ where: { action: 'newsletter.unsubscribe', entityId: String(id) } })).toBe(1);
    expect(missingAudit).toEqual([]);
  });

  it('CSV export: password re-check; current subscribers only; formula-safe cells; unsubscribe links; audited', async () => {
    const evil = `=cmd${uniq()}@example.com`;
    await prisma.newsletterSubscriber.create({ data: { email: evil, unsubscribeToken: 'c'.repeat(32) } });
    await prisma.newsletterSubscriber.create({ data: { email: `gone${uniq()}@example.com`, unsubscribeToken: 'd'.repeat(32), status: 'UNSUBSCRIBED', unsubscribedAt: new Date() } });
    stepUp = false;
    expect((await admin('get', '/newsletter/export.csv')).body.error.code).toBe('STEP_UP_REQUIRED');
    stepUp = true;
    const res = await admin('get', '/newsletter/export.csv');
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="artq-newsletter-\d{4}-\d{2}-\d{2}\.csv"$/);
    const text = res.text.replace(/^\uFEFF/, '');
    expect(text.split('\r\n')[0]).toBe('"email","source","subscribed_at","unsubscribe_url"');
    expect(text).toContain(`"'${evil}","footer"`);
    expect(text).toContain(`"${WEB}/newsletter/unsubscribe?token=${'c'.repeat(32)}"`);
    expect(text).not.toContain('d'.repeat(32));
    expect(await prisma.auditLog.count({ where: { action: 'newsletter.export' } })).toBe(1);
  });
});
