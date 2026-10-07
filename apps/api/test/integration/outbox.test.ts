// Task 1.8: outbox dispatcher + email consumer + retention, on real PostgreSQL + Redis/BullMQ.
// ✅ Kill dispatcher between enqueue and commit → no duplicate email; outbox DEAD → exception.
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthService, DEFAULT_AUTH_TIMINGS } from '../../src/auth/service.js';
import { MemorySessionCache } from '../../src/auth/session-cache.js';
import * as fn from '../../src/db/functions.js';
import { EmailInProgressError, processEmailDelivery, UnsupportedEmailEventError } from '../../src/email/consumer.js';
import { MemoryTransport } from '../../src/email/transport.js';
import { QUEUE } from '../../src/jobs/registry.js';
import { runRetention } from '../../src/jobs/retention.js';
import { dispatchOnce, OUTBOX_CONSUMERS, type OutboxJobData } from '../../src/outbox/dispatcher.js';
import { createWorkerRuntime } from '../../src/worker/runtime.js';
import { createMigratedDatabase, type TestDb } from '../helpers/db.js';
import { uniq } from '../helpers/fixtures.js';
import { startPostgres, startRedis, type Service } from '../helpers/services.js';

const log = pino({ level: 'silent' });
const FROM = 'ArtQ <no-reply@artq.in>';
let pg: Service, rd: Service, db: TestDb, prisma: PrismaClient, connection: { host: string; port: number; maxRetriesPerRequest: null };
let prefix: string, queues: Map<string, Queue>, transport: MemoryTransport, auth: AuthService;

beforeAll(async () => {
  [pg, rd] = await Promise.all([startPostgres(), startRedis()]);
  db = await createMigratedDatabase(pg.url);
  prisma = db.prisma;
  const u = new URL(rd.url);
  connection = { host: u.hostname, port: Number(u.port), maxRetriesPerRequest: null };
  auth = new AuthService(prisma, new MemorySessionCache(), { ...DEFAULT_AUTH_TIMINGS, jwt: { secret: new TextEncoder().encode('x'.repeat(40)), issuer: 't' }, otpPepper: 'test-otp-pepper-0123', linkSecret: 'l'.repeat(40), webUrl: 'http://localhost:3000', adminUrl: 'http://localhost:5173' });
}, 180_000);
afterAll(async () => { await db?.drop(); await Promise.all([pg?.stop(), rd?.stop()]); });

beforeEach(async () => {
  for (const q of queues?.values() ?? []) await q.close();
  prefix = `t${randomBytes(4).toString('hex')}`;                        // isolated BullMQ keyspace per test
  queues = new Map(Object.values(OUTBOX_CONSUMERS).map((n) => [n, new Queue(n, { connection, prefix })]));
  await Promise.all([...queues.values()].map((q) => q.waitUntilReady()));   // never close a queue that is still connecting
  transport = new MemoryTransport();
  await prisma.$executeRaw`UPDATE outbox_deliveries SET status = 'COMPLETED', completed_at = now() WHERE status <> 'COMPLETED'`;   // start each test with an empty backlog
});

const deps = () => ({ prisma, queues, log });
const emailDeps = () => ({ prisma, transport, from: FROM, log });
const deliveryOf = async (to: string) => {
  const [r] = await prisma.$queryRaw<{ id: bigint; event_id: bigint }[]>`
    SELECT d.id, d.event_id FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id
     WHERE e.event_type = 'email.auth' AND e.payload->>'to' = ${to} ORDER BY d.id DESC LIMIT 1`;
  return { deliveryId: Number(r!.id), eventId: Number(r!.event_id) };
};
const delivery = (id: number) => prisma.outboxDelivery.findUniqueOrThrow({ where: { id } });
const jobsOf = async (deliveryId: number) => (await queues.get('email.customer')!.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'])).filter((j) => (j.data as OutboxJobData).deliveryId === deliveryId);
/** An ACTIVE user who asked for a login code: one email.auth event with one email.customer delivery. */
async function otpRequested() {
  const email = `u${uniq()}@example.com`;
  await prisma.user.create({ data: { email, status: 'ACTIVE', emailVerifiedAt: new Date() } });
  await auth.requestLoginOtp({ email });
  return { email, ...(await deliveryOf(email)) };
}

describe('dispatcher', () => {
  it('claims, publishes with a deterministic job id and marks PUBLISHED; the consumer sends once and completes', async () => {
    const o = await otpRequested();
    expect(await dispatchOnce(deps())).toMatchObject({ claimed: 1, published: 1, failed: 0, leaseLost: 0 });
    expect(await delivery(o.deliveryId)).toMatchObject({ status: 'PUBLISHED', generation: 1, leaseToken: null });
    const [job] = await jobsOf(o.deliveryId);
    expect(job!.id).toBe(`outbox-${o.deliveryId}-1`);
    expect(job!.name).toBe('email.auth');
    expect(await processEmailDelivery(emailDeps(), 'email.customer', o.deliveryId)).toEqual({ status: 'SENT', sent: 1, skipped: 0 });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({ to: o.email, from: FROM, subject: expect.stringMatching(/^\d{6} is your ArtQ code$/) });
    expect(transport.sent[0]!.idempotencyKey).toMatch(new RegExp(`^artq-outbox-${o.deliveryId}-[0-9a-f]{12}-\\d+-\\d+$`));
    expect(await delivery(o.deliveryId)).toMatchObject({ status: 'COMPLETED' });
    expect(await prisma.emailLog.findFirstOrThrow({ where: { outboxDeliveryId: o.deliveryId } })).toMatchObject({ status: 'SENT', providerMessageId: 'mem-1', attempts: 1, template: 'otp' });
    expect(await dispatchOnce(deps())).toMatchObject({ claimed: 0 });
  });

  it('ACCEPTANCE: dispatcher killed between enqueue and commit → republished as the next generation, but only one email', async () => {
    const o = await otpRequested();
    await expect(dispatchOnce({ ...deps(), afterAdd: () => { throw new Error('SIGKILL'); } })).rejects.toThrow('SIGKILL');
    expect(await delivery(o.deliveryId)).toMatchObject({ status: 'LEASED', generation: 1 });
    expect(await dispatchOnce(deps())).toMatchObject({ claimed: 0 });                    // lease still live: nobody steals it
    await prisma.$executeRaw`UPDATE outbox_deliveries SET lease_expires_at = now() - interval '1 second' WHERE id = ${o.deliveryId}`;
    expect(await dispatchOnce(deps())).toMatchObject({ claimed: 1, published: 1 });
    expect((await jobsOf(o.deliveryId)).map((j) => j.id).sort()).toEqual([`outbox-${o.deliveryId}-1`, `outbox-${o.deliveryId}-2`]);
    // both jobs run, even concurrently
    const results = await Promise.allSettled([
      processEmailDelivery(emailDeps(), 'email.customer', o.deliveryId),
      processEmailDelivery(emailDeps(), 'email.customer', o.deliveryId),
    ]);
    const settled = results.map((r) => (r.status === 'fulfilled' ? r.value.status : (r.reason as Error).name));
    expect(settled.sort()).toEqual(expect.arrayContaining(['SENT']));
    expect(settled.every((s) => ['SENT', 'ALREADY_DONE', 'EmailInProgressError'].includes(s))).toBe(true);
    expect(await processEmailDelivery(emailDeps(), 'email.customer', o.deliveryId)).toMatchObject({ status: 'ALREADY_DONE' });
    expect(transport.sent).toHaveLength(1);
  });

  it('the stale dispatcher cannot ack after a newer owner took over (fenced)', async () => {
    const o = await otpRequested();
    let staleToken: string | undefined;
    const stale = await dispatchOnce({ ...deps(), afterAdd: async () => {
      staleToken = (await delivery(o.deliveryId)).leaseToken!;
      await prisma.$executeRaw`UPDATE outbox_deliveries SET lease_expires_at = now() - interval '1 second' WHERE id = ${o.deliveryId}`;
      await dispatchOnce(deps());                                    // a second dispatcher reclaims and publishes gen 2
    } });
    expect(staleToken).toBeTruthy();
    expect(stale).toMatchObject({ claimed: 1, published: 0, leaseLost: 1 });           // its ack was refused
    expect(await delivery(o.deliveryId)).toMatchObject({ status: 'PUBLISHED', generation: 2 });
    expect(await fn.outboxMarkPublished(prisma, o.deliveryId, staleToken!)).toBe(false);
  });

  it('a repeated add within one generation is ignored by BullMQ', async () => {
    const o = await otpRequested();
    await dispatchOnce(deps());
    await queues.get('email.customer')!.add('email.auth', { deliveryId: o.deliveryId, eventId: o.eventId, generation: 1 }, { jobId: `outbox-${o.deliveryId}-1` });
    expect(await jobsOf(o.deliveryId)).toHaveLength(1);
  });

  it('Redis losing a published job: republished after the redelivery timeout and delivered once', async () => {
    const o = await otpRequested();
    await dispatchOnce(deps());
    await queues.get('email.customer')!.obliterate({ force: true });               // broker loses everything
    expect(await dispatchOnce(deps())).toMatchObject({ claimed: 0 });               // not yet: within 30 min
    await prisma.$executeRaw`UPDATE outbox_deliveries SET published_at = now() - interval '31 minutes' WHERE id = ${o.deliveryId}`;
    expect(await dispatchOnce(deps())).toMatchObject({ published: 1 });
    expect((await jobsOf(o.deliveryId)).map((j) => j.id)).toEqual([`outbox-${o.deliveryId}-2`]);
    await processEmailDelivery(emailDeps(), 'email.customer', o.deliveryId);
    expect(transport.sent).toHaveLength(1);
  });

  it('ACCEPTANCE: a delivery past 10 generations becomes DEAD and raises one OUTBOX_DEAD exception', async () => {
    const o = await otpRequested();
    await prisma.$executeRaw`UPDATE outbox_deliveries SET generation = 10 WHERE id = ${o.deliveryId}`;
    // The only thing claimed is the admin notification that the new exception emitted (aq_raise_exception → notify.admin).
    expect(await dispatchOnce(deps())).toMatchObject({ claimed: 1, published: 1 });
    expect(await delivery(o.deliveryId)).toMatchObject({ status: 'DEAD' });
    const ex = await prisma.paymentException.findFirstOrThrow({ where: { type: 'OUTBOX_DEAD', dedupeKey: `OUTBOX_DEAD:${o.deliveryId}` } });
    expect(await prisma.paymentException.count({ where: { type: 'OUTBOX_DEAD', dedupeKey: `OUTBOX_DEAD:${o.deliveryId}` } })).toBe(1);
    const alert = await prisma.outboxEvent.findFirstOrThrow({ where: { eventType: 'payment.exception_raised', aggregateId: String(ex.id) }, include: { deliveries: true } });
    expect(alert.deliveries.map((d) => [d.consumer, d.status])).toEqual([['notify.admin', 'PUBLISHED']]);
    expect((await queues.get('notify.admin')!.getJobCounts('waiting')).waiting).toBe(1);
    expect(await jobsOf(o.deliveryId)).toHaveLength(0);
    expect(await processEmailDelivery(emailDeps(), 'email.customer', o.deliveryId)).toMatchObject({ status: 'ALREADY_DONE' });
    expect(transport.sent).toHaveLength(0);
  });

  it('an unknown consumer is never dropped: publish fails with backoff until it is DEAD', async () => {
    const eventId = await fn.emit(prisma, { aggregateType: 'test', aggregateId: uniq(), type: 'test.event', payload: {}, consumers: ['no.such.consumer'] });
    const id = Number((await prisma.outboxDelivery.findFirstOrThrow({ where: { eventId } })).id);
    expect(await dispatchOnce(deps())).toMatchObject({ claimed: 1, failed: 1, published: 0 });
    const d = await delivery(id);
    expect(d).toMatchObject({ status: 'PENDING', lastError: 'no queue for outbox consumer "no.such.consumer"' });
    expect(d.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    await prisma.$executeRaw`UPDATE outbox_deliveries SET generation = 10, next_attempt_at = now() WHERE id = ${id}`;
    await dispatchOnce(deps());
    expect((await delivery(id)).status).toBe('DEAD');
  });

  it('three dispatchers running at once publish each delivery exactly once', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 30; i++) {
      const e = await fn.emit(prisma, { aggregateType: 'user', aggregateId: '0', type: 'email.auth', payload: { template: 'password_changed', to: `p${i}@x.in`, data: {} }, consumers: ['email.customer'] });
      ids.push(Number((await prisma.outboxDelivery.findFirstOrThrow({ where: { eventId: e } })).id));
    }
    const rs = await Promise.all([dispatchOnce(deps(), { limit: 10 }), dispatchOnce(deps(), { limit: 10 }), dispatchOnce(deps(), { limit: 10 }), dispatchOnce(deps(), { limit: 10 })]);
    expect(rs.reduce((s, r) => s + r.published, 0)).toBe(30);
    const jobs = await queues.get('email.customer')!.getJobs(['waiting']);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(30);
    expect((await prisma.outboxDelivery.findMany({ where: { id: { in: ids.map(BigInt) } } })).every((d) => d.status === 'PUBLISHED' && d.generation === 1)).toBe(true);
  });
});

describe('email consumer', () => {
  it('provider failure: logged as FAILED, delivery stays open; the retry sends with the same idempotency key', async () => {
    const o = await otpRequested();
    transport.failNext = 1;
    await expect(processEmailDelivery(emailDeps(), 'email.customer', o.deliveryId)).rejects.toThrow('simulated failure');
    expect(await prisma.emailLog.findFirstOrThrow({ where: { outboxDeliveryId: o.deliveryId } })).toMatchObject({ status: 'FAILED', attempts: 1, error: expect.stringContaining('simulated') });
    expect((await delivery(o.deliveryId)).status).not.toBe('COMPLETED');
    await processEmailDelivery(emailDeps(), 'email.customer', o.deliveryId);
    expect(transport.sent).toHaveLength(1);
    expect(await prisma.emailLog.findFirstOrThrow({ where: { outboxDeliveryId: o.deliveryId } })).toMatchObject({ status: 'SENT', attempts: 2 });
    expect((await delivery(o.deliveryId)).status).toBe('COMPLETED');
  });

  it('a crash after the provider accepted (SENDING left behind): wait while in flight, then resend with the SAME key', async () => {
    const o = await otpRequested();
    const keys: string[] = [];
    const crashing = { name: 'crash', send: async (m: { idempotencyKey: string }) => { keys.push(m.idempotencyKey); throw Object.assign(new Error('process killed'), { name: 'Killed' }); } };
    // simulate the kill: the FAILED update never happens
    await expect(processEmailDelivery({ ...emailDeps(), transport: crashing as never }, 'email.customer', o.deliveryId)).rejects.toThrow();
    await prisma.$executeRaw`UPDATE email_logs SET status = 'SENDING', updated_at = now() WHERE outbox_delivery_id = ${o.deliveryId}`;
    await expect(processEmailDelivery(emailDeps(), 'email.customer', o.deliveryId)).rejects.toBeInstanceOf(EmailInProgressError);
    expect(transport.sent).toHaveLength(0);
    await prisma.$executeRaw`UPDATE email_logs SET updated_at = now() - interval '3 minutes' WHERE outbox_delivery_id = ${o.deliveryId}`;
    await processEmailDelivery(emailDeps(), 'email.customer', o.deliveryId);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.idempotencyKey).toBe(keys[0]);           // the provider deduplicates on this key
  });

  it('the OTP code is scrubbed from the stored event once the email is sent', async () => {
    const o = await otpRequested();
    const before = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: o.eventId } });
    expect((before.payload as { data: { code: string } }).data.code).toMatch(/^\d{6}$/);
    await processEmailDelivery(emailDeps(), 'email.customer', o.deliveryId);
    const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: o.eventId } });
    expect(after.payload).toEqual({ template: 'otp', to: o.email, scrubbed: true });
  });

  it('events the consumer has no email for fail loudly and stay open (they surface as OUTBOX_DEAD, never silently dropped)', async () => {
    const e = await fn.emit(prisma, { aggregateType: 'order', aggregateId: 'AQ1', type: 'order.shipped', payload: {}, consumers: ['email.customer'] });
    const id = Number((await prisma.outboxDelivery.findFirstOrThrow({ where: { eventId: e } })).id);
    await expect(processEmailDelivery(emailDeps(), 'email.customer', id)).rejects.toBeInstanceOf(UnsupportedEmailEventError);
    expect((await delivery(id)).status).not.toBe('COMPLETED');
    // An order email whose order is missing (or not named) fails the same way instead of sending something empty.
    for (const payload of [{}, { order_id: 999_999_999 }]) {
      const o = await fn.emit(prisma, { aggregateType: 'order', aggregateId: 'AQ1', type: 'order.placed', payload, consumers: ['email.customer'] });
      const oid = Number((await prisma.outboxDelivery.findFirstOrThrow({ where: { eventId: o } })).id);
      await expect(processEmailDelivery(emailDeps(), 'email.customer', oid)).rejects.toThrow(/order .* not found/);
      expect((await delivery(oid)).status).not.toBe('COMPLETED');
    }
    const bad = await fn.emit(prisma, { aggregateType: 'user', aggregateId: '0', type: 'email.auth', payload: { template: 'no_such_template', to: 'a@x.in', data: {} }, consumers: ['email.customer'] });
    await expect(processEmailDelivery(emailDeps(), 'email.customer', Number((await prisma.outboxDelivery.findFirstOrThrow({ where: { eventId: bad } })).id))).rejects.toThrow(/unknown email template/);
    expect(transport.sent).toHaveLength(0);
  });

  it('email.admin: one email per NOTIFY.adminEmails recipient; a partial failure resends only the missing one; none configured ⇒ completed', async () => {
    const send = async () => {
      const e = await fn.emit(prisma, { aggregateType: 'payment_exception', aggregateId: uniq(), type: 'payment.exception_raised', payload: { type: 'OUTBOX_DEAD', order_id: null }, consumers: ['email.admin'] });
      return Number((await prisma.outboxDelivery.findFirstOrThrow({ where: { eventId: e } })).id);
    };
    await prisma.setting.upsert({ where: { key: 'NOTIFY' }, create: { key: 'NOTIFY', value: { adminEmails: [], dailySummary: true, lowStockEmail: true } }, update: { value: { adminEmails: [], dailySummary: true, lowStockEmail: true } } });
    expect(await processEmailDelivery(emailDeps(), 'email.admin', await send())).toEqual({ status: 'NO_RECIPIENTS', sent: 0, skipped: 0 });
    await prisma.setting.update({ where: { key: 'NOTIFY' }, data: { value: { adminEmails: ['owner@artq.in', 'ops@artq.in', 'OWNER@artq.in'], dailySummary: true, lowStockEmail: true } } });
    const id = await send();
    const flaky = { name: 'flaky', calls: 0, send: async (m: { to: string }) => { flaky.calls++; if (m.to === 'ops@artq.in' && flaky.calls === 2) throw new Error('smtp down'); return transport.send(m as never); } };
    await expect(processEmailDelivery({ ...emailDeps(), transport: flaky as never }, 'email.admin', id)).rejects.toThrow('smtp down');
    expect(await processEmailDelivery({ ...emailDeps(), transport: flaky as never }, 'email.admin', id)).toEqual({ status: 'SENT', sent: 1, skipped: 1 });
    expect(transport.sent.map((m) => m.to).sort()).toEqual(['ops@artq.in', 'owner@artq.in']);
    expect(transport.sent[0]!.subject).toBe('[ArtQ] Payment exception: OUTBOX_DEAD');
  });
});

describe('end to end through BullMQ workers', () => {
  it('a login-code request reaches the inbox via the scheduled dispatcher and the email worker', async () => {
    const runtime = createWorkerRuntime({
      connection, log, prefix,
      queues: [
        { name: QUEUE.outboxDispatch, concurrency: 1, attempts: 1, processor: async () => dispatchOnce({ prisma, queues: runtime.queues, log }) },
        { name: 'email.customer', concurrency: 2, processor: async (job) => processEmailDelivery(emailDeps(), 'email.customer', (job.data as OutboxJobData).deliveryId) },
      ],
      producers: Object.values(OUTBOX_CONSUMERS),
      schedulers: [{ queue: QUEUE.outboxDispatch, id: 'outbox-dispatch', everyMs: 1000, jobName: 'dispatch' }],
    });
    await runtime.start();
    try {
      const o = await otpRequested();
      const deadline = Date.now() + 15_000;
      while (transport.sent.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      expect(transport.sent.map((m) => m.to)).toEqual([o.email]);
      const code = transport.sent[0]!.subject.slice(0, 6);
      expect((await auth.verifyLoginOtp({ email: o.email, code }, { ip: null, userAgent: null })).user.email).toBe(o.email);   // the emailed code works
      expect((await delivery(o.deliveryId)).status).toBe('COMPLETED');
    } finally {
      await runtime.stop();
    }
  }, 30_000);
});

describe('retention', () => {
  it('purges old outbox rows, ended sessions with their tokens, old codes and reset links; keeps DEAD and recent rows; idempotent', async () => {
    // outbox: old completed (purged with its event), recent completed (kept), old DEAD (kept)
    const mk = async (consumer: string) => { const e = await fn.emit(prisma, { aggregateType: 'test', aggregateId: uniq(), type: 'test.event', payload: {}, consumers: [consumer] }); return { e, d: Number((await prisma.outboxDelivery.findFirstOrThrow({ where: { eventId: e } })).id) }; };
    const oldDone = await mk('email.customer');
    const recentDone = await mk('email.customer');
    const oldDead = await mk('email.customer');
    await prisma.$executeRaw`UPDATE outbox_deliveries SET status = 'COMPLETED', completed_at = now() - interval '31 days' WHERE id = ${oldDone.d}`;
    await prisma.$executeRaw`UPDATE outbox_events SET created_at = now() - interval '31 days' WHERE id IN (${oldDone.e}, ${oldDead.e})`;
    await prisma.$executeRaw`UPDATE outbox_deliveries SET status = 'COMPLETED', completed_at = now() - interval '1 day' WHERE id = ${recentDone.d}`;
    await prisma.$executeRaw`UPDATE outbox_deliveries SET status = 'DEAD' WHERE id = ${oldDead.d}`;
    // an email.auth payload that finished without the in-line scrub
    const leaked = await fn.emit(prisma, { aggregateType: 'user', aggregateId: '0', type: 'email.auth', payload: { template: 'otp', to: 'z@x.in', data: { code: '123456' } }, consumers: ['email.customer'] });
    await prisma.$executeRaw`UPDATE outbox_deliveries SET status = 'COMPLETED', completed_at = now() WHERE event_id = ${leaked}`;
    await prisma.$executeRaw`UPDATE outbox_events SET created_at = now() - interval '2 hours' WHERE id = ${leaked}`;
    // auth data
    const user = await prisma.user.create({ data: { email: `r${uniq()}@x.in`, status: 'ACTIVE' } });
    const session = (ended: string | null) => prisma.$queryRaw<{ id: string }[]>`
      WITH s AS (INSERT INTO sessions (user_id, audience, auth_version, idle_expires_at, absolute_expires_at, revoked_at)
                 VALUES (${user.id}, 'STOREFRONT', 1, now() + interval '1 day', now() + interval '2 days', ${ended}::timestamptz) RETURNING id)
      , t AS (INSERT INTO refresh_tokens (session_id, token_hash, expires_at) SELECT id, md5(random()::text) || md5(random()::text), now() FROM s)
      SELECT id::text FROM s`;
    const [oldSession] = await session(new Date(Date.now() - 31 * 86_400_000).toISOString());
    const [liveSession] = await session(null);
    await prisma.$executeRaw`INSERT INTO otp_codes (target, channel, purpose, code_hash, expires_at) VALUES ('o@x.in', 'EMAIL', 'LOGIN', ${'a'.repeat(64)}, now() - interval '2 days'), ('o@x.in', 'EMAIL', 'LOGIN', ${'b'.repeat(64)}, now() + interval '5 minutes')`;
    await prisma.$executeRaw`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (${user.id}, ${'c'.repeat(64)}, now() - interval '2 days'), (${user.id}, ${'d'.repeat(64)}, now() + interval '20 minutes')`;

    const r = await runRetention(prisma);
    expect(r).toMatchObject({ outboxDeliveries: 1, outboxEvents: 1, emailPayloadsScrubbed: 1, sessions: 1, otpCodes: 1, resetTokens: 1 });
    expect(await prisma.outboxEvent.findUnique({ where: { id: oldDone.e } })).toBeNull();
    expect(await prisma.outboxDelivery.findUnique({ where: { id: recentDone.d } })).not.toBeNull();
    expect(await prisma.outboxDelivery.findUnique({ where: { id: oldDead.d } })).toMatchObject({ status: 'DEAD' });
    expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: leaked } })).payload).toEqual({ template: 'otp', to: 'z@x.in', scrubbed: true });
    expect(await prisma.session.findUnique({ where: { id: oldSession!.id } })).toBeNull();
    expect(await prisma.refreshToken.count({ where: { sessionId: oldSession!.id } })).toBe(0);
    expect(await prisma.session.findUnique({ where: { id: liveSession!.id } })).not.toBeNull();
    expect(await prisma.otpCode.count({ where: { target: 'o@x.in' } })).toBe(1);
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id } })).toBe(1);
    expect(await runRetention(prisma)).toEqual({ outboxDeliveries: 0, outboxEvents: 0, emailPayloadsScrubbed: 0, sessions: 0, otpCodes: 0, resetTokens: 0, idempotencyKeys: 0, accountsAnonymised: 0, cartsDeleted: 0, cartsStripped: 0 });
  });

  it('works through backlogs larger than one batch', async () => {
    for (let i = 0; i < 25; i++) await prisma.$executeRaw`INSERT INTO otp_codes (target, channel, purpose, code_hash, expires_at) VALUES (${`b${i}@x.in`}, 'EMAIL', 'LOGIN', ${'e'.repeat(64)}, now() - interval '3 days')`;
    expect((await runRetention(prisma, { batch: 10 })).otpCodes).toBeGreaterThanOrEqual(25);
  });
});
