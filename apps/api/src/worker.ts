import { PrismaClient } from '@prisma/client';
import type { Job } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { ConfigError, loadEnv } from './config/env.js';
import { processEmailDelivery, type EmailConsumer } from './email/consumer.js';
import { ResendTransport, SmtpTransport, type EmailTransport } from './email/transport.js';
import { processSearchQueue } from './db/functions.js';
import { jobId } from './jobs/ids.js';
import { QUEUE } from './jobs/registry.js';
import { importEnqueue } from './imports/queues.js';
import { RedisAppCache } from './lib/app-cache.js';
import { ImportService } from './imports/service.js';
import { runCatalogChecks } from './jobs/catalog-check.js';
import { runRetention } from './jobs/retention.js';
import { dispatchOnce, OUTBOX_CONSUMERS, type OutboxJobData } from './outbox/dispatcher.js';
import { processWebhook, sweepWebhooks, WEBHOOK_QUEUE } from './webhooks/inbox.js';
import { razorpayProvider } from './webhooks/provider.js';
import { CartService } from './cart/service.js';
import { CheckoutService } from './checkout/initiate.js';
import { RazorpayClient } from './payments/razorpay.js';
import { expirePending, reconcileAttempts, reconcileDaily } from './payments/reconcile.js';
import { razorpayHandlers } from './payments/webhook-handlers.js';
import { processCreditNote, RefundAdminService } from './payments/refund-admin.js';
import { processRefundSend, reconcileRefunds } from './payments/refunds.js';
import { mediaServiceFromEnv, mediaStorageFromEnv } from './media/factory.js';
import { codOverdueCheck } from './orders/cod.js';
import { processRestockNotify } from './restock/service.js';
import { notifyAlerts } from './ops/alerts.js';
import { countRecentFailed, lastRunKey, syncAllBadges } from './ops/service.js';
import { DispatchService, processInvoiceRender } from './orders/dispatch.js';
import { createWorkerRuntime } from './worker/runtime.js';
import { DEFAULT_AUTH_TIMINGS } from './auth/service.js';
import { redisConnection } from './lib/redis-url.js';

let env;
try { env = loadEnv(); }
catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(1); } throw e; }

const log = pino({ name: 'worker', level: env.LOG_LEVEL });
const connection = redisConnection(env.REDIS_URL);
const redis = new Redis(env.REDIS_URL);
redis.on('error', (err) => log.warn({ err: err.message }, 'redis connection error'));
const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });

const transport: EmailTransport = env.EMAIL_TRANSPORT === 'resend'
  ? new ResendTransport({ apiKey: env.RESEND_API_KEY! })
  : new SmtpTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT });
const email = (consumer: EmailConsumer) => async (job: Job<OutboxJobData>) =>
  processEmailDelivery({ prisma, transport, from: env.EMAIL_FROM, log, links: { webUrl: env.WEB_URL, linkSecret: env.AUTH_LINK_SECRET, setPasswordTtlS: DEFAULT_AUTH_TIMINGS.setPasswordTtlS } }, consumer, job.data.deliveryId);

// Razorpay (task 4.9): webhook handlers and the payment jobs need the API keys; without them online payments are off.
const razorpay = env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET ? new RazorpayClient(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET) : null;
const mediaUrl = (key: string) => `${env.MEDIA_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`;
const checkout = new CheckoutService({ prisma, carts: new CartService(prisma, mediaUrl), provider: razorpay, mediaUrl, storeName: 'ArtQ' });
const payments = razorpay ? { prisma, provider: razorpay, checkout, log } : null;
const providers = [razorpayProvider(env.RAZORPAY_WEBHOOK_SECRET || undefined, razorpay ? razorpayHandlers(razorpay) : undefined)];
// Uploads are queued by the API; images downloaded by catalogue imports are queued here. Retries: BullMQ attempts.
const invoices = new DispatchService(prisma, mediaStorageFromEnv(env));
const media = mediaServiceFromEnv(env, prisma, async (id) => { await runtime.queues.get(QUEUE.mediaProcess)!.add('media.process', { id }, { jobId: jobId('media', id, Date.now()), attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: true }); });
const appCache = new RedisAppCache(redis, (op, err) => log.warn({ op, err: String(err) }, 'app cache unavailable'));
const imports = new ImportService({
  prisma, onCatalogChanged: () => appCache.invalidate('navigation'), readFile: (m) => media.read(m), ingestImage: (url, userId) => media.ingestRemote(url, userId),
  enqueue: { validate: (id, c) => importEnqueue(runtime.queues.get(QUEUE.importValidate)!, runtime.queues.get(QUEUE.importApply)!).validate(id, c), apply: (id) => importEnqueue(runtime.queues.get(QUEUE.importValidate)!, runtime.queues.get(QUEUE.importApply)!).apply(id) },
});

/** Records each scheduled run for Jobs & Webhooks ("last runs"); a failure is recorded, then rethrown for BullMQ. */
async function recordRun<T>(name: string, run: () => Promise<T>): Promise<T> {
  const save = (ok: boolean, result: unknown) => redis.set(lastRunKey(name), JSON.stringify({ at: new Date().toISOString(), ok, result: (typeof result === 'string' ? result : JSON.stringify(result) ?? '').slice(0, 300) }), 'EX', 7 * 86_400).catch(() => undefined);
  try { const r = await run(); await save(true, r); return r; } catch (e) { await save(false, e instanceof Error ? e.message : String(e)); throw e; }
}

const runtime = createWorkerRuntime({
  connection, log,
  queues: [
    { name: QUEUE.maintenance, concurrency: 1, processor: async (job) => recordRun(job.name, async () => {
      if (job.name === 'ops-alerts') { await syncAllBadges(prisma); return notifyAlerts(prisma, { recentFailed: await countRecentFailed(runtime.queues.values()) }); }
      if (job.name === 'retention') return runRetention(prisma);
      if (job.name === 'webhook-sweep') return sweepWebhooks(prisma, runtime.queues.get(WEBHOOK_QUEUE)!);
      if (job.name === 'media-purge') return media.purgeStale();
      if (job.name === 'import-sweep') return imports.sweep();
      if (job.name === 'payments-reconcile') return payments ? reconcileAttempts(payments) : 'no Razorpay keys';
      if (job.name === 'orders-expire') return expirePending({ prisma, provider: razorpay, checkout, log });
      if (job.name === 'payments-daily') return payments ? reconcileDaily(payments) : 'no Razorpay keys';
      if (job.name === 'cod-overdue') return codOverdueCheck(prisma);
      if (job.name === 'refunds-reconcile') return razorpay ? reconcileRefunds({ prisma, provider: razorpay, log }) : 'no Razorpay keys';
      if (job.name === 'catalog-check') {
        const r = await runCatalogChecks(prisma);
        if (r.driftRepaired.length) log.error({ products: r.driftRepaired }, 'product aggregate drift repaired; investigate the write path');
        return r;
      }
      await redis.set('worker:heartbeat', new Date().toISOString(), 'EX', 300);
      return 'ok';
    }) },
    // One dispatch at a time per process; several processes are safe (SKIP LOCKED + fenced leases).
    { name: QUEUE.outboxDispatch, concurrency: 1, attempts: 1, processor: async () => dispatchOnce({ prisma, queues: runtime.queues, log }) },
    // Domain failures are recorded by aq_webhook_fail (with backoff) and retried by the sweeper, so the job itself completes.
    { name: WEBHOOK_QUEUE, concurrency: 5, attempts: 1, processor: async (job) => processWebhook({ prisma, providers, log }, (job.data as { id: number }).id) },
    // Bad files end REJECTED (no retry); transient storage/processing errors throw ⇒ FAILED, retried by BullMQ.
    { name: QUEUE.mediaProcess, concurrency: 2, attempts: 3, backoffMs: 10_000, processor: async (job) => media.process((job.data as { id: number }).id) },
    // Variant/category/type changes enqueue products in search_reindex_queue (database.md §7); drained every 2 s.
    { name: QUEUE.searchReindex, concurrency: 1, attempts: 1, processor: async () => processSearchQueue(prisma) },
    // Validation waits (retries) while media processing checks the uploaded workbook; apply resumes from PENDING rows.
    { name: QUEUE.importValidate, concurrency: 1, attempts: 60, backoffMs: 5000, processor: async (job) => {
      const { id, createMissing } = job.data as { id: number; createMissing: boolean };
      const r = await imports.validate(id, createMissing);
      if (r === 'WAITING') throw new Error(`import ${id}: the file is still being checked`);
      return r;
    } },
    { name: QUEUE.importApply, concurrency: 1, attempts: 1, processor: async (job) => imports.apply((job.data as { id: number }).id) },
    { name: OUTBOX_CONSUMERS['email.customer'], concurrency: 5, processor: email('email.customer') },
    { name: OUTBOX_CONSUMERS['refund.send'], concurrency: 2, processor: async (job) => {
      if (!razorpay) throw new Error('Razorpay keys are not configured: refunds cannot be sent');   // retried, then OUTBOX_DEAD: never silently dropped
      return processRefundSend({ prisma, provider: razorpay, log }, (job.data as OutboxJobData).deliveryId);
    } },
    { name: OUTBOX_CONSUMERS['invoice.credit_note'], concurrency: 2, processor: async (job) => processCreditNote({ prisma, refunds: new RefundAdminService(prisma), log }, (job.data as OutboxJobData).deliveryId) },
    { name: OUTBOX_CONSUMERS['invoice.render'], concurrency: 2, processor: async (job) => processInvoiceRender({ prisma, dispatch: invoices, log }, (job.data as OutboxJobData).deliveryId) },
    { name: OUTBOX_CONSUMERS['email.admin'], concurrency: 2, processor: email('email.admin') },
    // Back in stock (task 5.9): waiting customers are emailed once while the size is available.
    { name: OUTBOX_CONSUMERS['restock.notify'], concurrency: 1, processor: async (job) => processRestockNotify({ prisma, log }, (job.data as OutboxJobData).deliveryId) },
    // Payment exceptions raised by the database functions notify staff by email (task 5.8).
    { name: OUTBOX_CONSUMERS['notify.admin'], concurrency: 2, processor: email('email.admin') },
  ],
  // Consumers implemented in later phases: their jobs wait in Redis (and PostgreSQL) until a worker exists.
  producers: Object.values(OUTBOX_CONSUMERS),
  schedulers: [
    { queue: QUEUE.maintenance, id: 'heartbeat', everyMs: 60_000, jobName: 'heartbeat' },
    { queue: QUEUE.maintenance, id: 'retention', everyMs: 3_600_000, jobName: 'retention' },
    { queue: QUEUE.maintenance, id: 'webhook-sweep', everyMs: 60_000, jobName: 'webhook-sweep' },
    { queue: QUEUE.maintenance, id: 'media-purge', everyMs: 3_600_000, jobName: 'media-purge' },
    { queue: QUEUE.maintenance, id: 'import-sweep', everyMs: 60_000, jobName: 'import-sweep' },
    { queue: QUEUE.maintenance, id: 'catalog-check', everyMs: 86_400_000, jobName: 'catalog-check' },
    // Payments (architecture.md §7.4). The daily reconciliation covers the previous IST day, so its run time is free.
    { queue: QUEUE.maintenance, id: 'payments-reconcile', everyMs: 60_000, jobName: 'payments-reconcile' },
    { queue: QUEUE.maintenance, id: 'refunds-reconcile', everyMs: 300_000, jobName: 'refunds-reconcile' },
    { queue: QUEUE.maintenance, id: 'cod-overdue', everyMs: 86_400_000, jobName: 'cod-overdue' },
    { queue: QUEUE.maintenance, id: 'ops-alerts', everyMs: 300_000, jobName: 'ops-alerts' },
    { queue: QUEUE.maintenance, id: 'orders-expire', everyMs: 60_000, jobName: 'orders-expire' },
    { queue: QUEUE.maintenance, id: 'payments-daily', everyMs: 86_400_000, jobName: 'payments-daily' },
    { queue: QUEUE.outboxDispatch, id: 'outbox-dispatch', everyMs: 1000, jobName: 'dispatch' },
    { queue: QUEUE.searchReindex, id: 'search-reindex', everyMs: 2000, jobName: 'reindex' },
  ],
});
await runtime.start();
log.info({ transport: transport.name }, 'email transport');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    log.info({ sig }, 'worker shutting down');
    await runtime.stop();
    await prisma.$disconnect();
    redis.disconnect();
    process.exit(0);
  });
}
