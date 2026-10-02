// Task 1.9: durable webhook inbox on real PostgreSQL + Redis/BullMQ with a synthetic provider.
// ✅ AT-04: crash after durable receipt (inbox row committed, worker killed mid-processing) → endpoint returned 200 only
// after commit; the sweeper reclaims after lock expiry; the order is paid exactly once.
import { createHmac, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import type { Express } from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import * as fn from '../../src/db/functions.js';
import { QUEUE } from '../../src/jobs/registry.js';
import { createWorkerRuntime } from '../../src/worker/runtime.js';
import { processWebhook, sweepWebhooks, WEBHOOK_QUEUE, webhookRouter } from '../../src/webhooks/inbox.js';
import { hmacHexMatches, razorpayProvider, type WebhookHandler, type WebhookProvider } from '../../src/webhooks/provider.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { attempt, catalog, order, tx, uniq } from '../helpers/fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const log = pino({ level: 'silent' });
const SECRET = 'synth-webhook-secret';
let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, connection: { host: string; port: number; maxRetriesPerRequest: null };
let queue: Queue, prefix: string;

/** What the synthetic provider's API returns when the handler re-fetches a payment (authoritative state). */
const providerApi = new Map<string, { providerOrderId: string; amount: number; status: 'CAPTURED' | 'AUTHORIZED' }>();
const hooks: { beforeFetchReturns?: () => Promise<void> } = {};

const paymentHandler: WebhookHandler<{ providerOrderId: string; paymentId: string; amount: number; status: 'CAPTURED' | 'AUTHORIZED' }> = {
  async fetch(ev) {
    const paymentId = (ev.payload as { payment_id: string }).payment_id;
    const snap = providerApi.get(paymentId);
    if (!snap) throw new Error(`payment ${paymentId} not found at provider`);
    await hooks.beforeFetchReturns?.();
    return { ...snap, paymentId };
  },
  async apply(t, p) {
    await fn.applyProviderPayment(t, { providerOrderId: p.providerOrderId, paymentId: p.paymentId, amount: p.amount, currency: 'INR', status: p.status, amountRefunded: 0, capturedAt: new Date(), method: 'upi', raw: {}, actor: 'WEBHOOK' });
    return 'PROCESSED';
  },
};
const synth: WebhookProvider = {
  slug: 'synth', name: 'SYNTH',
  verify: (raw, h) => hmacHexMatches(SECRET, raw, h['x-synth-signature'] as string | undefined),
  eventId: (h) => (h['x-synth-event-id'] as string | undefined) ?? null,
  eventType: (b) => (b as { event?: string }).event ?? null,
  createdAt: () => null,
  handlers: {
    'payment.captured': paymentHandler as WebhookHandler,
    'payment.boom': { fetch: async () => { throw new Error('provider API 500'); }, apply: async () => {} },
  },
};
const providers = () => [synth, razorpayProvider('rzp-secret')];

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  const u = new URL(rd.url);
  connection = { host: u.hostname, port: Number(u.port), maxRetriesPerRequest: null };
}, 180_000);
afterAll(async () => { await queue?.close(); await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });
beforeEach(async () => {
  await queue?.close();
  prefix = `w${randomBytes(4).toString('hex')}`;
  queue = new Queue(WEBHOOK_QUEUE, { connection, prefix });
  await queue.waitUntilReady();                                      // never close a queue that is still connecting
  delete hooks.beforeFetchReturns;
});

const appWith = (o: { prisma?: PrismaClient; queue?: Pick<Queue, 'add'> | null } = {}): Express => createApp({
  version: 't', origins: { storefront: ['http://localhost:3000'], admin: ['http://localhost:5173'] }, readiness: { database: async () => {}, redis: async () => {} },
  routes: [webhookRouter({ prisma: o.prisma ?? prisma, queue: o.queue === undefined ? queue : o.queue, providers: providers(), log })],
});
const sign = (body: string, secret = SECRET) => createHmac('sha256', secret).update(body).digest('hex');
/** Sends a webhook exactly as a provider would: no Origin, JSON body, signature over the raw bytes. */
function deliver(a: Express, body: object, o: { eventId?: string | null; signature?: string | null; raw?: string; slug?: string } = {}) {
  const raw = o.raw ?? JSON.stringify(body);
  let r = request(a).post(`/v1/webhooks/${o.slug ?? 'synth'}`).set('Content-Type', 'application/json');
  if (o.signature !== null) r = r.set('X-Synth-Signature', o.signature ?? sign(JSON.stringify(body)));
  if (o.eventId !== null) r = r.set('X-Synth-Event-Id', o.eventId ?? `evt_${uniq()}`);
  return r.send(raw);
}
const rowOf = (eventId: string) => prisma.webhookEvent.findUnique({ where: { provider_eventId: { provider: 'SYNTH', eventId } } });
const jobIds = async () => (await queue.getJobs(['waiting', 'delayed', 'active'])).map((j) => j.id);
const proc = () => ({ prisma, providers: providers(), log });

/** An order awaiting payment, plus the provider-side snapshot the webhook handler will fetch. */
async function pendingPayment() {
  const cat = await catalog(prisma, [[{ price: 50_000, onHand: 5 }]]);
  const o = await tx(prisma, (t) => order(t, { lines: [{ variantId: cat.products[0]!.variantIds[0]!, qty: 1 }] }));
  const a = await attempt(prisma, o.orderId, o.total);
  const paymentId = `pay_${uniq()}`;
  providerApi.set(paymentId, { providerOrderId: a.providerOrderId, amount: o.total, status: 'CAPTURED' });
  return { ...o, paymentId };
}

describe('receiving', () => {
  it('a valid webhook is stored, acknowledged with 200 only after commit, and enqueued as wh-<id>', async () => {
    const eventId = `evt_${uniq()}`;
    const res = await deliver(appWith(), { event: 'payment.captured', payment_id: 'pay_x' }, { eventId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    const row = await rowOf(eventId);                               // already committed when the 200 arrived
    expect(row).toMatchObject({ provider: 'SYNTH', eventType: 'payment.captured', status: 'RECEIVED', payload: { event: 'payment.captured', payment_id: 'pay_x' } });
    expect(await jobIds()).toEqual([`wh-${row!.id}`]);
  });

  it.each([
    ['missing signature', { signature: null }],
    ['wrong secret', { signature: sign('{"event":"payment.captured"}', 'not-the-secret') }],
    ['body changed after signing', { signature: sign('{"event":"payment.captured"}'), raw: '{"event":"payment.captured","amount":1}' }],
    ['malformed signature', { signature: 'abc' }],
  ])('%s → 400 INVALID_SIGNATURE and nothing stored', async (_d, o) => {
    const eventId = `evt_${uniq()}`;
    const res = await deliver(appWith(), { event: 'payment.captured' }, { eventId, ...o });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    expect(await rowOf(eventId)).toBeNull();
  });

  it('a signature over different whitespace fails: the HMAC covers the exact raw bytes', async () => {
    const raw = '{"event": "payment.captured"}';                     // spaces: JSON.stringify would differ
    expect((await deliver(appWith(), {}, { raw, signature: sign(raw) })).status).toBe(200);
    expect((await deliver(appWith(), {}, { raw, signature: sign('{"event":"payment.captured"}') })).status).toBe(400);
  });

  it('missing event id → 400; unknown provider → 404; provider without a secret → 503 (it retries)', async () => {
    expect((await deliver(appWith(), { event: 'payment.captured' }, { eventId: null })).status).toBe(400);
    expect((await deliver(appWith(), { event: 'x' }, { slug: 'nope' })).status).toBe(404);
    const unconfigured = createApp({ version: 't', origins: { storefront: ['http://localhost:3000'], admin: ['http://localhost:5173'] }, readiness: { database: async () => {}, redis: async () => {} },
      routes: [webhookRouter({ prisma, queue, providers: [razorpayProvider(undefined)], log })] });
    const r = await deliver(unconfigured, { event: 'payment.captured' }, { slug: 'razorpay' });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('WEBHOOK_NOT_CONFIGURED');
  });

  it('database down → 503 so the provider retries; nothing acknowledged', async () => {
    const { PrismaClient } = await import('@prisma/client');
    const dead = new PrismaClient({ datasourceUrl: 'postgresql://postgres:postgres@127.0.0.1:1/none' });
    const res = await deliver(appWith({ prisma: dead }), { event: 'payment.captured' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('UNAVAILABLE');
    await dead.$disconnect();
  });

  it('Redis down at receipt: still 200 (the row is durable) and the sweeper enqueues it later', async () => {
    const eventId = `evt_${uniq()}`;
    const res = await deliver(appWith({ queue: { add: async () => { throw new Error('ECONNREFUSED'); } } }), { event: 'payment.captured', payment_id: 'pay_y' }, { eventId });
    expect(res.status).toBe(200);
    const row = await rowOf(eventId);
    expect(await jobIds()).toEqual([]);
    expect(await sweepWebhooks(prisma, queue)).toContain(row!.id);
    expect(await jobIds()).toContain(`wh-${row!.id}`);
  });

  it('duplicate deliveries: one row; re-enqueued only while work remains; 200 every time', async () => {
    const eventId = `evt_${uniq()}`;
    const body = { event: 'payment.unhandled' };
    for (let i = 0; i < 3; i++) expect((await deliver(appWith(), body, { eventId })).status).toBe(200);
    expect(await prisma.webhookEvent.count({ where: { eventId } })).toBe(1);
    const row = (await rowOf(eventId))!;
    expect(await jobIds()).toEqual([`wh-${row.id}`]);                 // same job id: BullMQ keeps one
    expect(await processWebhook(proc(), row.id)).toBe('IGNORED');
    await queue.obliterate({ force: true });
    expect((await deliver(appWith(), body, { eventId })).status).toBe(200);
    expect(await jobIds()).toEqual([]);                               // IGNORED: nothing left to do
  });

  it('webhooks need no Origin header (exempt from the origin policy)', async () => {
    expect((await deliver(appWith(), { event: 'payment.unhandled' })).status).toBe(200);
  });
});

describe('processing', () => {
  it('re-fetches the payment and applies it once; the order becomes paid', async () => {
    const p = await pendingPayment();
    await deliver(appWith(), { event: 'payment.captured', payment_id: p.paymentId });
    const row = await prisma.webhookEvent.findFirstOrThrow({ where: { payload: { path: ['payment_id'], equals: p.paymentId } } });
    expect(await processWebhook(proc(), row.id)).toBe('PROCESSED');
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'PROCESSED', leaseToken: null, attempts: 1 });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: p.orderId } })).toMatchObject({ status: 'PLACED', paymentStatus: 'PAID' });
    expect(await processWebhook(proc(), row.id)).toBe('NOT_CLAIMED');
  });

  it('ACCEPTANCE AT-04: worker killed mid-processing → swept after the lease expires → order paid exactly once', async () => {
    const p = await pendingPayment();
    const eventId = `evt_${uniq()}`;
    const res = await deliver(appWith(), { event: 'payment.captured', payment_id: p.paymentId }, { eventId });
    expect(res.status).toBe(200);
    const id = (await rowOf(eventId))!.id;
    // worker 1 claims the event and dies before finishing (no fail, no complete)
    expect(await fn.webhookClaim(prisma, id, 300)).toBeTruthy();
    expect((await rowOf(eventId))!.status).toBe('PROCESSING');
    await queue.obliterate({ force: true });
    expect(await sweepWebhooks(prisma, queue)).not.toContain(id);          // lease still live
    expect(await processWebhook(proc(), id)).toBe('NOT_CLAIMED');           // nobody else may take it yet
    await prisma.$executeRaw`UPDATE webhook_events SET locked_until = now() - interval '1 second' WHERE id = ${id}`;
    expect(await sweepWebhooks(prisma, queue)).toContain(id);
    expect(await jobIds()).toContain(`wh-${id}`);                  // (rows left due by earlier tests are swept too)
    expect(await processWebhook(proc(), id)).toBe('PROCESSED');
    // the provider redelivers, and also sends a second event for the same payment
    expect((await deliver(appWith(), { event: 'payment.captured', payment_id: p.paymentId }, { eventId })).status).toBe(200);
    await deliver(appWith(), { event: 'payment.captured', payment_id: p.paymentId });
    for (const r of await prisma.webhookEvent.findMany({ where: { status: { in: ['RECEIVED'] } } })) await processWebhook(proc(), r.id);
    expect(await prisma.payment.count({ where: { providerPaymentId: p.paymentId } })).toBe(1);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: p.orderId } })).toMatchObject({ status: 'PLACED', paymentStatus: 'PAID', capturedAmount: p.total });
    expect(await prisma.inventoryReservation.count({ where: { orderId: p.orderId, status: 'ACTIVE' } })).toBe(1);
  });

  it('a stale worker that resumes after its lease was taken over cannot apply anything (fenced)', async () => {
    const p = await pendingPayment();
    const eventId = `evt_${uniq()}`;
    await deliver(appWith(), { event: 'payment.captured', payment_id: p.paymentId }, { eventId });
    const id = (await rowOf(eventId))!.id;
    let resumeStale!: () => void;
    const staleGate = new Promise<void>((r) => { resumeStale = r; });
    hooks.beforeFetchReturns = async () => { delete hooks.beforeFetchReturns; await staleGate; };   // only the first worker pauses
    const stale = processWebhook({ ...proc(), leaseS: 1, renewMs: 60_000 }, id);
    await new Promise((r) => setTimeout(r, 1500));                                                  // its 1 s lease expires
    expect(await processWebhook(proc(), id)).toBe('PROCESSED');                                      // worker 2 takes over
    resumeStale();
    expect(await stale).toBe('LEASE_LOST');
    expect(await prisma.payment.count({ where: { providerPaymentId: p.paymentId } })).toBe(1);
    expect((await rowOf(eventId))!.status).toBe('PROCESSED');
  });

  it('a slow fetch keeps its lease by renewing it', async () => {
    const p = await pendingPayment();
    const eventId = `evt_${uniq()}`;
    await deliver(appWith(), { event: 'payment.captured', payment_id: p.paymentId }, { eventId });
    const id = (await rowOf(eventId))!.id;
    hooks.beforeFetchReturns = () => new Promise((r) => setTimeout(r, 2500));
    const slow = processWebhook({ ...proc(), leaseS: 1, renewMs: 300 }, id);
    await new Promise((r) => setTimeout(r, 1800));
    expect(await processWebhook(proc(), id)).toBe('NOT_CLAIMED');           // lease renewed: nobody steals it
    expect(await slow).toBe('PROCESSED');
  });

  it('failures back off, are retried by the sweeper when due, and the 10th is DEAD with one WEBHOOK_DEAD exception', async () => {
    const eventId = `evt_${uniq()}`;
    await deliver(appWith(), { event: 'payment.boom' }, { eventId });
    const id = (await rowOf(eventId))!.id;
    expect(await processWebhook(proc(), id)).toBe('FAILED');
    const failed = (await rowOf(eventId))!;
    expect(failed).toMatchObject({ status: 'FAILED', attempts: 1, lastError: 'provider API 500', leaseToken: null });
    expect(failed.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(50_000);              // 30 s × 2¹
    await queue.obliterate({ force: true });
    expect(await sweepWebhooks(prisma, queue)).not.toContain(id);                            // not due yet
    await prisma.$executeRaw`UPDATE webhook_events SET next_attempt_at = now(), attempts = 9 WHERE id = ${id}`;
    expect(await sweepWebhooks(prisma, queue)).toContain(id);
    expect(await processWebhook(proc(), id)).toBe('DEAD');
    expect((await rowOf(eventId))!.status).toBe('DEAD');
    expect(await prisma.paymentException.count({ where: { type: 'WEBHOOK_DEAD', webhookEventId: id } })).toBe(1);
    expect(await sweepWebhooks(prisma, queue)).not.toContain(id);
  });

  it('a handler for an event that went missing at the provider fails rather than silently succeeding', async () => {
    const eventId = `evt_${uniq()}`;
    await deliver(appWith(), { event: 'payment.captured', payment_id: 'pay_unknown' }, { eventId });
    expect(await processWebhook(proc(), (await rowOf(eventId))!.id)).toBe('FAILED');
    expect((await rowOf(eventId))!.lastError).toBe('payment pay_unknown not found at provider');
  });

  it('Razorpay until Phase 4: handled events fail visibly; other events are IGNORED', async () => {
    const rzp = (event: string) => {
      const body = JSON.stringify({ event, created_at: 1_790_000_000 });
      return request(appWith()).post('/v1/webhooks/razorpay').set('Content-Type', 'application/json')
        .set('X-Razorpay-Signature', sign(body, 'rzp-secret')).set('X-Razorpay-Event-Id', `evt_${uniq()}`).send(body);
    };
    expect((await rzp('payment.captured')).status).toBe(200);
    expect((await rzp('invoice.paid')).status).toBe(200);
    const rows = await prisma.webhookEvent.findMany({ where: { provider: 'RAZORPAY' }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => r.providerCreatedAt?.toISOString())).toEqual([new Date(1_790_000_000_000).toISOString(), new Date(1_790_000_000_000).toISOString()]);
    expect(await processWebhook(proc(), rows[0]!.id)).toBe('FAILED');
    expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { id: rows[0]!.id } })).lastError).toContain('not implemented yet');
    expect(await processWebhook(proc(), rows[1]!.id)).toBe('IGNORED');
  });
});

describe('end to end through the worker', () => {
  it('HTTP receipt → BullMQ job → processed; the scheduled sweeper picks up an event whose enqueue failed', async () => {
    const runtime = createWorkerRuntime({
      connection, log, prefix,
      queues: [
        { name: WEBHOOK_QUEUE, concurrency: 2, attempts: 1, processor: async (job) => processWebhook(proc(), (job.data as { id: number }).id) },
        { name: QUEUE.maintenance, concurrency: 1, processor: async () => sweepWebhooks(prisma, runtime.queues.get(WEBHOOK_QUEUE)!) },
      ],
      schedulers: [{ queue: QUEUE.maintenance, id: 'webhook-sweep', everyMs: 1000, jobName: 'webhook-sweep' }],
    });
    await runtime.start();
    try {
      const a = await pendingPayment();
      await deliver(appWith(), { event: 'payment.captured', payment_id: a.paymentId });
      const b = await pendingPayment();
      await deliver(appWith({ queue: { add: async () => { throw new Error('redis blip'); } } }), { event: 'payment.captured', payment_id: b.paymentId });
      const paid = async () => (await prisma.order.findMany({ where: { id: { in: [a.orderId, b.orderId] }, paymentStatus: 'PAID' } })).length;
      const deadline = Date.now() + 15_000;
      while ((await paid()) < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      expect(await paid()).toBe(2);
    } finally {
      await runtime.stop();
    }
  }, 30_000);
});
