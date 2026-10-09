// Task 5.8 on real PostgreSQL + Redis (and real BullMQ queues): Payment Exceptions (queue filters, resolve / dismiss
// once with a note, the order's badge follows, permissions, audit, the exception email via notify.admin), manual
// reconcile (one order through the fake Razorpay; no keys / COD / unknown order refused), Jobs & Webhooks (summary with
// queue depths, inbox and outbox counts, search queue, last runs and alerts; retrying a dead webhook, a dead delivery
// and a failed BullMQ job; only dead or failed ones), and the alert email (once per alert per hour).
import type { PrismaClient, UserRole } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
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
import * as fn from '../../src/db/functions.js';
import { processEmailDelivery } from '../../src/email/consumer.js';
import { MemoryTransport } from '../../src/email/transport.js';
import { BULLMQ_BASE } from '../../src/jobs/registry.js';
import { hashPassword } from '../../src/lib/password.js';
import { redisConnection } from '../../src/lib/redis-url.js';
import { evaluateAlerts, notifyAlerts } from '../../src/ops/alerts.js';
import { registerOpsRoutes } from '../../src/ops/routes.js';
import { lastRunKey, OpsService, syncAllBadges } from '../../src/ops/service.js';
import { FakeRazorpay } from '../../src/payments/razorpay.js';
import { seedGeo, seedSettings, seedShipping } from '../../src/seed/steps.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { attempt, catalog, order, tx, uniq } from '../helpers/fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const ORIGIN = 'http://localhost:5173';
const JWT = { secret: new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123'), issuer: 'artq-test' };
const log = pino({ level: 'silent' });
let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, redis: Redis, app: Express, variantId: number;
let SUPER: { token: string }, ADMIN: { token: string }, STAFF: { token: string };
let fake: FakeRazorpay | null, queue: Queue, worker: Worker;
const enqueued: number[] = [];
const missingAudit: string[] = [];

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  redis = new Redis(rd.url);
  await seedShipping(prisma); await seedGeo(prisma); await seedSettings(prisma);
  const notify = { adminEmails: ['owner@artq.in'], dailySummary: true, lowStockEmail: true };
  await prisma.setting.upsert({ where: { key: 'NOTIFY' }, update: { value: notify }, create: { key: 'NOTIFY', value: notify } });
  variantId = (await tx(prisma, (t) => catalog(t, [[{ price: 50_000, onHand: 1000 }]]))).products[0]!.variantIds[0]!;
  queue = new Queue(`ops-test-${uniq()}`, { ...BULLMQ_BASE, connection: redisConnection(rd.url) });
  worker = new Worker(queue.name, async (job) => { if (job.data.fail) throw new Error('simulated job failure'); return 'ok'; }, { ...BULLMQ_BASE, connection: redisConnection(rd.url) });
  const cache = new RedisSessionCache(redis);
  const service = new AuthService(prisma, cache, { ...DEFAULT_AUTH_TIMINGS, jwt: JWT, otpPepper: 'test-otp-pepper-0123', linkSecret: 'test-link-secret-0123456789abcdef0123', webUrl: 'http://localhost:3000', adminUrl: ORIGIN });
  const deps = { prisma, cache, jwt: JWT };
  const admin = createAdminRouter({ ...deps, limiter: { hit: async () => ({ count: 0, resetMs: 60_000 }) }, log, hasRecentStepUp: async () => true, onMissingAudit: (req) => missingAudit.push(`${req.method} ${req.originalUrl}`) });
  registerOpsRoutes(admin, new OpsService({
    prisma, queues: new Map([[queue.name, queue]]), get provider() { return fake; },
    readLastRuns: (names) => redis.mget(...names.map(lastRunKey)), enqueueWebhook: async (id) => { enqueued.push(id); },
  } as never), log);
  app = createApp({ version: 't', origins: { storefront: [], admin: [ORIGIN] }, readiness: { database: async () => {}, redis: async () => {} }, routes: [adminAuthRouter({ ...deps, service, env: 'test', limiter: { hit: async () => ({ count: 0, resetMs: 60_000 }) } }), admin.router] });
  [SUPER, ADMIN, STAFF] = [await staff('SUPER_ADMIN'), await staff('ADMIN'), await staff('STAFF')];
}, 180_000);
afterAll(async () => { await worker?.close(); await queue?.obliterate({ force: true }).catch(() => {}); await queue?.close(); redis?.disconnect(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });
beforeEach(() => { fake = new FakeRazorpay(); missingAudit.length = 0; enqueued.length = 0; });

async function staff(role: UserRole) {
  const email = `${role.toLowerCase()}${uniq()}@artq.in`;
  await prisma.user.create({ data: { email, name: role, role, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword('ops-password-1') } });
  return { token: (await request(app).post('/v1/admin/auth/login').set('Origin', ORIGIN).send({ email, password: 'ops-password-1' })).body.accessToken as string };
}
const get = (path: string, who = ADMIN) => request(app).get(`/v1/admin${path}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${who.token}`);
const post = (path: string, body: object = {}, who = ADMIN) => request(app).post(`/v1/admin${path}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${who.token}`).send(body);
const fields = (res: request.Response) => Object.fromEntries((res.body.error?.details ?? []).map((d: { path: string; message: string }) => [d.path, d.message]));
const placed = () => tx(prisma, (t) => order(t, { lines: [{ variantId, qty: 1 }] }));
const raise = (type: fn.ExceptionType, orderId: number | null, ageMin = 0) => tx(prisma, async (t) => {
  const key = `${type}:${uniq()}`;
  await fn.raiseException(t, { type, dedupeKey: key, orderId, amount: 1000, details: { why: 'test' } });
  if (ageMin) await t.$executeRaw`UPDATE payment_exceptions SET created_at = now() - make_interval(mins => ${ageMin}::int) WHERE dedupe_key = ${key}`;
  return (await t.paymentException.findUniqueOrThrow({ where: { dedupeKey: key } })).id;
});

describe('payment exceptions', () => {
  it('queue filters; resolve needs a note and happens once; the badge clears only with the last open one; audited; STAFF 403', async () => {
    const o = await placed();
    const [a, b] = [await raise('REFUND_FAILED', o.orderId), await raise('OVERSOLD', o.orderId)];
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).hasOpenException).toBe(true);
    const list = await get(`/payment-exceptions?open=1&orderId=${o.orderId}`);
    expect(list.body.data.map((r: { id: number }) => r.id)).toEqual([b, a]);
    expect(list.body.data[0]).toMatchObject({ type: 'OVERSOLD', status: 'OPEN', order: { id: o.orderId }, details: { why: 'test' } });
    expect((await get(`/payment-exceptions?type=REFUND_FAILED&orderId=${o.orderId}`)).body.data.map((r: { id: number }) => r.id)).toEqual([a]);
    expect((await get('/payment-exceptions', STAFF)).status).toBe(403);

    expect(fields(await post(`/payment-exceptions/${a}/resolve`, { resolution: 'ok' }))).toEqual({ resolution: 'Say what you did' });
    const r = await post(`/payment-exceptions/${a}/resolve`, { resolution: 'Refunded by bank transfer, UTR 123' });
    expect(r.body).toMatchObject({ status: 'RESOLVED', resolution: 'Refunded by bank transfer, UTR 123', resolvedBy: 'ADMIN' });
    expect((await post(`/payment-exceptions/${a}/dismiss`, { note: 'Not needed' })).body.error.code).toBe('INVALID_TRANSITION');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).hasOpenException).toBe(true);           // OVERSOLD still open
    expect((await post(`/payment-exceptions/${b}/dismiss`, { note: 'Recounted, stock was right' })).body.status).toBe('DISMISSED');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).hasOpenException).toBe(false);
    expect((await post('/payment-exceptions/999999/resolve', { resolution: 'nothing here' })).status).toBe(404);
    expect(await prisma.auditLog.count({ where: { entity: 'payment_exception', entityId: { in: [String(a), String(b)] } } })).toBe(2);
    expect(missingAudit).toEqual([]);
  });

  it('auto-resolved exceptions: the badge is cleared by the ops job', async () => {
    const o = await placed();
    const id = await raise('EXCESS_CAPTURE', o.orderId);
    await prisma.paymentException.update({ where: { id }, data: { status: 'RESOLVED' } });
    expect(await syncAllBadges(prisma)).toBeGreaterThanOrEqual(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).hasOpenException).toBe(false);
  });

  it('the exception email: notify.admin deliveries are sent to staff', async () => {
    const o = await placed();
    const id = await raise('AMOUNT_MISMATCH', o.orderId);
    const [d] = await prisma.$queryRaw<{ id: bigint }[]>`SELECT d.id FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id WHERE e.aggregate_id = ${String(id)} AND d.consumer = 'notify.admin'`;
    const mail = new MemoryTransport();
    await processEmailDelivery({ prisma, transport: mail, from: 'x@artq.in', log }, 'email.admin', Number(d!.id));
    expect(mail.sent[0]).toMatchObject({ to: 'owner@artq.in', subject: '[ArtQ] Payment exception: AMOUNT_MISMATCH' });
  });

  it('manual reconcile: one order through Razorpay; refused without keys, for COD and unknown orders', async () => {
    const o = await placed();
    await prisma.order.update({ where: { id: o.orderId }, data: { paymentStatus: 'UNPAID' } });
    const a = await tx(prisma, (t) => attempt(t, o.orderId, o.total));
    fake!.pay(a.providerOrderId, { amount: o.total });
    const r = await post('/payments/reconcile', { orderId: o.orderId });
    expect([r.status, r.body.applied]).toEqual([200, 1]);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe('PLACED');
    const cod = await tx(prisma, (t) => order(t, { lines: [{ variantId, qty: 1 }], method: 'COD' }));
    expect((await post('/payments/reconcile', { orderId: cod.orderId })).status).toBe(422);
    expect((await post('/payments/reconcile', { orderId: 999999 })).status).toBe(404);
    expect((await post('/payments/reconcile', {})).body.applied).toBe(0);
    fake = null;
    expect((await post('/payments/reconcile', { orderId: o.orderId })).body.error.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
    expect(await prisma.auditLog.count({ where: { action: 'payments.reconcile' } })).toBe(2);
  });
});

describe('jobs & webhooks', () => {
  it('summary: queue depths, inbox and outbox counts, search queue, last runs, alerts', async () => {
    await prisma.$executeRaw`INSERT INTO webhook_events (provider, event_id, event_type, payload, status, attempts, received_at) VALUES ('razorpay', ${`evt_${uniq()}`}, 'payment.captured', '{}', 'DEAD', 10, now() - interval '1 hour')`;
    await redis.set(lastRunKey('refunds-reconcile'), JSON.stringify({ at: '2026-10-09T10:00:00.000Z', ok: true, result: '{"checked":0}' }));
    await queue.add('noop', {}, { removeOnComplete: false });
    const s = (await get('/ops/summary')).body;
    expect(s.webhooks.DEAD).toBeGreaterThanOrEqual(1);
    expect(s.queues).toEqual([expect.objectContaining({ name: queue.name })]);
    expect(s.schedulers.find((x: { name: string }) => x.name === 'refunds-reconcile')).toEqual({ name: 'refunds-reconcile', lastRunAt: '2026-10-09T10:00:00.000Z', ok: true, result: '{"checked":0}' });
    expect(s.schedulers.find((x: { name: string }) => x.name === 'cod-overdue').lastRunAt).toBeNull();
    expect(s.alerts.map((a: { key: string }) => a.key)).toContain('webhooks-failing');
    expect(s).toHaveProperty('searchQueue.depth');
    expect((await get('/ops/summary', STAFF)).status).toBe(403);
  });

  it('webhooks: list by status; retry a dead one (super admin only) → received and enqueued; a processed one cannot be retried', async () => {
    const id = Number((await prisma.$queryRaw<{ id: number }[]>`INSERT INTO webhook_events (provider, event_id, event_type, payload, status, attempts, last_error) VALUES ('razorpay', ${`evt_${uniq()}`}, 'payment.captured', '{}', 'DEAD', 10, 'boom') RETURNING id`)[0]!.id);
    const done = Number((await prisma.$queryRaw<{ id: number }[]>`INSERT INTO webhook_events (provider, event_id, event_type, payload, status, processed_at) VALUES ('razorpay', ${`evt_${uniq()}`}, 'payment.captured', '{}', 'PROCESSED', now()) RETURNING id`)[0]!.id);
    expect((await get('/ops/webhooks?status=DEAD')).body.data.some((w: { id: number; lastError: string }) => w.id === id && w.lastError === 'boom')).toBe(true);
    expect((await post(`/ops/webhooks/${id}/retry`, {}, ADMIN)).status).toBe(403);
    expect((await post(`/ops/webhooks/${id}/retry`, {}, SUPER)).status).toBe(200);
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id }, select: { status: true, attempts: true, lastError: true } })).toEqual({ status: 'RECEIVED', attempts: 0, lastError: null });
    expect(enqueued).toEqual([id]);
    expect((await post(`/ops/webhooks/${done}/retry`, {}, SUPER)).body.error.code).toBe('INVALID_TRANSITION');
    expect((await post('/ops/webhooks/999999/retry', {}, SUPER)).status).toBe(404);
  });

  it('outbox: stuck and dead deliveries listed; a dead one goes back to pending with the generation reset', async () => {
    const o = await placed();
    const eid = await fn.emit(prisma, { aggregateType: 'order', aggregateId: o.orderNumber, type: 'order.placed', payload: { order_id: o.orderId }, consumers: ['email.customer', 'email.admin'] });
    await prisma.$executeRaw`UPDATE outbox_deliveries SET status = 'DEAD', generation = 10, last_error = 'smtp down' WHERE event_id = ${eid}::bigint AND consumer = 'email.customer'`;
    await prisma.$executeRaw`UPDATE outbox_deliveries SET status = 'PUBLISHED', published_at = now() - interval '1 hour', generation = 1 WHERE event_id = ${eid}::bigint AND consumer = 'email.admin'`;
    const [dead] = await prisma.$queryRaw<{ id: bigint }[]>`SELECT id FROM outbox_deliveries WHERE event_id = ${eid}::bigint AND consumer = 'email.customer'`;
    expect((await get('/ops/outbox-deliveries?status=DEAD&consumer=email.customer')).body.data.some((d: { id: number; lastError: string }) => d.id === Number(dead!.id) && d.lastError === 'smtp down')).toBe(true);
    expect((await get('/ops/outbox-deliveries?status=STUCK')).body.data.some((d: { consumer: string; aggregate: string }) => d.consumer === 'email.admin' && d.aggregate === `order ${o.orderNumber}`)).toBe(true);
    expect((await get('/ops/summary')).body.alerts.map((a: { key: string }) => a.key)).toContain('outbox-stuck');
    expect((await post(`/ops/outbox-deliveries/${Number(dead!.id)}/retry`, {}, SUPER)).status).toBe(200);
    expect((await prisma.$queryRaw<{ status: string; generation: number }[]>`SELECT status::text, generation FROM outbox_deliveries WHERE id = ${dead!.id}`)[0]).toEqual({ status: 'PENDING', generation: 0 });
    expect((await post(`/ops/outbox-deliveries/${Number(dead!.id)}/retry`, {}, SUPER)).body.error.code).toBe('INVALID_TRANSITION');
  });

  it('failed BullMQ jobs: listed with the reason; retried by a super admin; only failed jobs', async () => {
    const job = await queue.add('flaky', { fail: true }, { attempts: 1, removeOnFail: false });
    await expect.poll(async () => (await queue.getJob(job.id!))?.isFailed(), { timeout: 10_000 }).toBe(true);
    const list = (await get('/ops/jobs/failed')).body.data;
    expect(list).toContainEqual(expect.objectContaining({ queue: queue.name, id: job.id, name: 'flaky', failedReason: 'simulated job failure', attemptsMade: 1 }));
    await (await queue.getJob(job.id!))!.updateData({ fail: false });
    expect((await post(`/ops/jobs/${queue.name}/${job.id}/retry`, {}, SUPER)).status).toBe(200);
    await expect.poll(async () => (await queue.getJob(job.id!))?.isCompleted(), { timeout: 10_000 }).toBe(true);
    expect((await post(`/ops/jobs/${queue.name}/${job.id}/retry`, {}, SUPER)).body.error.code).toBe('INVALID_TRANSITION');
    expect((await post(`/ops/jobs/no-such-queue/${job.id}/retry`, {}, SUPER)).status).toBe(404);
    expect(await prisma.auditLog.count({ where: { action: 'job.retry' } })).toBe(1);
  });
});

describe('alerts', () => {
  it('money exceptions open over an hour page; the email goes once per alert per hour', async () => {
    const o = await placed();
    await raise('EXCESS_CAPTURE', o.orderId, 90);
    expect((await evaluateAlerts(prisma)).find((a) => a.key === 'money-exceptions')).toMatchObject({ severity: 'P1' });
    expect((await evaluateAlerts(prisma, { recentFailed: 11 })).map((a) => a.key)).toContain('jobs-failing');
    const now = new Date('2026-10-09T10:15:00Z');
    const first = await notifyAlerts(prisma, null, now);
    expect(first.notified).toBe(first.alerts);
    expect((await notifyAlerts(prisma, null, new Date('2026-10-09T10:45:00Z'))).notified).toBe(0);
    expect((await notifyAlerts(prisma, null, new Date('2026-10-09T11:05:00Z'))).notified).toBe(first.alerts);
    const [d] = await prisma.$queryRaw<{ id: bigint }[]>`SELECT d.id FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id WHERE e.event_type = 'ops.alert' AND e.aggregate_id LIKE 'money-exceptions@%' ORDER BY d.id LIMIT 1`;
    const mail = new MemoryTransport();
    await processEmailDelivery({ prisma, transport: mail, from: 'x@artq.in', log }, 'email.admin', Number(d!.id));
    expect(mail.sent[0]!.subject).toBe('[ArtQ P1] Money exceptions waiting over an hour');
  });
});
