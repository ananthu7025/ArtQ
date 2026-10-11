// ✅ AT-17 and AT-18 (task 7.1), on real PostgreSQL + Redis (BullMQ).
// AT-17: Redis loses an outbox job after PUBLISHED and a stale duplicate of it also arrives. Pass: republished as the
//        next generation after the timeout; the effect happens once; the delivery ends COMPLETED (C07).
// AT-18: a webhook worker stalls past its lease, another worker reclaims and completes, then the first resumes. Pass:
//        the stale complete / fail / renew are rejected; the domain change happens once; the event is PROCESSED (C08).
import { randomBytes } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fn from '../../src/db/functions.js';
import { processEmailDelivery } from '../../src/email/consumer.js';
import { MemoryTransport } from '../../src/email/transport.js';
import { dispatchOnce, OUTBOX_CONSUMERS, type OutboxJobData } from '../../src/outbox/dispatcher.js';
import { createAcceptanceApp, log, type AcceptanceApp } from '../helpers/acceptance-app.js';
import { uniq } from '../helpers/fixtures.js';

let t: AcceptanceApp;
beforeAll(async () => { t = await createAcceptanceApp(); }, 180_000);
afterAll(async () => { await t?.close(); });
beforeEach(() => t.reset());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AT-17: Redis loses a published outbox job; a stale duplicate also arrives', () => {
  it('republished as generation 2 after the timeout; both jobs run through BullMQ workers; one email; COMPLETED', async () => {
    const { host, port } = t.redis.options;
    const connection = { host: host!, port: port!, maxRetriesPerRequest: null };
    const prefix = `at17${randomBytes(4).toString('hex')}`;
    const queues = new Map(Object.values(OUTBOX_CONSUMERS).map((n) => [n, new Queue(n, { connection, prefix })]));
    await Promise.all([...queues.values()].map((q) => q.waitUntilReady()));
    await t.prisma.$executeRaw`UPDATE outbox_deliveries SET status = 'COMPLETED', completed_at = now() WHERE status <> 'COMPLETED'`;   // only this test's delivery
    const transport = new MemoryTransport();
    const handled: string[] = [];
    const worker = new Worker('email.customer', async (job: Job<OutboxJobData>) => {
      handled.push(job.id!);
      return processEmailDelivery({ prisma: t.prisma, transport, from: 'ArtQ <no-reply@artq.in>', log }, 'email.customer', job.data.deliveryId);
    }, { connection, prefix, concurrency: 4 });
    try {
      const to = `at17-${uniq()}@example.com`;
      await fn.emit(t.prisma, { aggregateType: 'user', aggregateId: '0', type: 'email.auth', payload: { template: 'password_changed', to, data: {} }, consumers: ['email.customer'] });
      const d = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { status: { not: 'COMPLETED' } }, orderBy: { id: 'desc' } });
      const deps = { prisma: t.prisma, queues, log };
      await worker.pause();                                   // the job is published but not yet picked up…
      expect(await dispatchOnce(deps)).toMatchObject({ published: 1 });
      const stale = (await queues.get('email.customer')!.getJob(`outbox-${d.id}-1`))!;
      const staleData = stale.data;
      await queues.get('email.customer')!.obliterate({ force: true });   // …and Redis loses it
      expect(await dispatchOnce(deps)).toMatchObject({ claimed: 0 });    // within the redelivery timeout: left alone
      await t.prisma.$executeRaw`UPDATE outbox_deliveries SET published_at = now() - interval '31 minutes' WHERE id = ${d.id}`;
      expect(await dispatchOnce(deps)).toMatchObject({ published: 1 });
      expect(await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: 'PUBLISHED', generation: 2 });
      // A stale duplicate of generation 1 also turns up (e.g. restored from an old Redis snapshot).
      await queues.get('email.customer')!.add('email.auth', staleData, { jobId: `outbox-${d.id}-1-replayed` });
      worker.resume();
      for (let i = 0; i < 100 && handled.length < 2; i++) await sleep(100);
      for (let i = 0; i < 50 && (await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: d.id } })).status !== 'COMPLETED'; i++) await sleep(100);
      expect(handled.sort()).toEqual([`outbox-${d.id}-1-replayed`, `outbox-${d.id}-2`]);
      expect(transport.sent.filter((m) => m.to === to)).toHaveLength(1);
      expect(await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: 'COMPLETED' });
      expect(await t.prisma.emailLog.count({ where: { outboxDeliveryId: d.id, status: 'SENT' } })).toBe(1);
    } finally {
      await worker.close();
      await Promise.all([...queues.values()].map((q) => q.close()));
    }
  });
});

describe('AT-18: a webhook worker stalls past its lease', () => {
  it('another worker reclaims and completes; the first resumes and is refused; the payment is applied once; PROCESSED', async () => {
    const g = await t.pending();
    const pay = t.fake.pay(g.attempts[0]!);
    const id = await t.hook('payment.captured', { payment: pay.id });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realFetch = t.fake.fetchPayment.bind(t.fake);
    let calls = 0;
    t.fake.fetchPayment = async (pid: string) => { calls++; if (calls === 1) await gate; return realFetch(pid); };   // worker A stalls at Razorpay

    const a = t.processEvent(id, { leaseS: 1, renewMs: 60_000 });   // A never renews in time
    await sleep(1300);                                              // A's lease has expired
    expect(await t.processEvent(id)).toBe('PROCESSED');             // worker B reclaims and completes
    release();
    expect(await a).toBe('LEASE_LOST');                             // A resumes: its transaction is refused and rolled back

    const o = await t.order(g.orderNumber);
    expect([o.status, o.payments.length, o.payments[0]!.allocation]).toEqual(['PLACED', 1, 'APPLIED']);
    expect(await t.prisma.outboxEvent.count({ where: { eventType: 'order.placed', aggregateId: g.orderNumber } })).toBe(1);
    expect(await t.prisma.orderStatusHistory.count({ where: { orderId: o.id, toValue: 'PLACED' } })).toBe(1);
    expect(await t.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'PROCESSED' });
  });

  it('a stale token cannot complete, fail or renew once a newer worker owns the event', async () => {
    const g = await t.pending();
    const id = await t.hook('payment.captured', { payment: t.fake.pay(g.attempts[0]!).id });
    const stale = (await fn.webhookClaim(t.prisma, id, 1))!;
    expect(stale).toBeTruthy();
    await sleep(1100);
    const fresh = (await fn.webhookClaim(t.prisma, id, 300))!;
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(stale);
    expect(await fn.webhookRenew(t.prisma, id, stale, 300)).toBe(false);
    expect(await fn.webhookBegin(t.prisma, id, stale)).toBe(false);
    await expect(t.prisma.$transaction((tx) => fn.webhookComplete(tx, id, stale))).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(await fn.webhookFail(t.prisma, id, stale, 'stale worker error')).toBe('LEASE_LOST');   // does nothing
    expect(await t.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'PROCESSING' });   // still the fresh worker's
    expect(await fn.webhookRenew(t.prisma, id, fresh, 300)).toBe(true);
  });
});
