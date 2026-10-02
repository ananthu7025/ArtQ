import { PrismaClient } from '@prisma/client';
import type { Job } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { ConfigError, loadEnv } from './config/env.js';
import { processEmailDelivery, type EmailConsumer } from './email/consumer.js';
import { ResendTransport, SmtpTransport, type EmailTransport } from './email/transport.js';
import { processSearchQueue } from './db/functions.js';
import { QUEUE } from './jobs/registry.js';
import { runCatalogChecks } from './jobs/catalog-check.js';
import { runRetention } from './jobs/retention.js';
import { dispatchOnce, OUTBOX_CONSUMERS, type OutboxJobData } from './outbox/dispatcher.js';
import { processWebhook, sweepWebhooks, WEBHOOK_QUEUE } from './webhooks/inbox.js';
import { razorpayProvider } from './webhooks/provider.js';
import { mediaServiceFromEnv } from './media/factory.js';
import { createWorkerRuntime } from './worker/runtime.js';
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
  processEmailDelivery({ prisma, transport, from: env.EMAIL_FROM, log }, consumer, job.data.deliveryId);

const providers = [razorpayProvider(env.RAZORPAY_WEBHOOK_SECRET || undefined)];
// The worker never enqueues media itself (the API does); retries come from BullMQ attempts.
const media = mediaServiceFromEnv(env, prisma, async () => {});

const runtime = createWorkerRuntime({
  connection, log,
  queues: [
    { name: QUEUE.maintenance, concurrency: 1, processor: async (job) => {
      if (job.name === 'retention') return runRetention(prisma);
      if (job.name === 'webhook-sweep') return sweepWebhooks(prisma, runtime.queues.get(WEBHOOK_QUEUE)!);
      if (job.name === 'media-purge') return media.purgeStale();
      if (job.name === 'catalog-check') {
        const r = await runCatalogChecks(prisma);
        if (r.driftRepaired.length) log.error({ products: r.driftRepaired }, 'product aggregate drift repaired; investigate the write path');
        return r;
      }
      await redis.set('worker:heartbeat', new Date().toISOString(), 'EX', 300);
      return 'ok';
    } },
    // One dispatch at a time per process; several processes are safe (SKIP LOCKED + fenced leases).
    { name: QUEUE.outboxDispatch, concurrency: 1, attempts: 1, processor: async () => dispatchOnce({ prisma, queues: runtime.queues, log }) },
    // Domain failures are recorded by aq_webhook_fail (with backoff) and retried by the sweeper, so the job itself completes.
    { name: WEBHOOK_QUEUE, concurrency: 5, attempts: 1, processor: async (job) => processWebhook({ prisma, providers, log }, (job.data as { id: number }).id) },
    // Bad files end REJECTED (no retry); transient storage/processing errors throw ⇒ FAILED, retried by BullMQ.
    { name: QUEUE.mediaProcess, concurrency: 2, attempts: 3, backoffMs: 10_000, processor: async (job) => media.process((job.data as { id: number }).id) },
    // Variant/category/type changes enqueue products in search_reindex_queue (database.md §7); drained every 2 s.
    { name: QUEUE.searchReindex, concurrency: 1, attempts: 1, processor: async () => processSearchQueue(prisma) },
    { name: OUTBOX_CONSUMERS['email.customer'], concurrency: 5, processor: email('email.customer') },
    { name: OUTBOX_CONSUMERS['email.admin'], concurrency: 2, processor: email('email.admin') },
  ],
  // Consumers implemented in later phases: their jobs wait in Redis (and PostgreSQL) until a worker exists.
  producers: Object.values(OUTBOX_CONSUMERS),
  schedulers: [
    { queue: QUEUE.maintenance, id: 'heartbeat', everyMs: 60_000, jobName: 'heartbeat' },
    { queue: QUEUE.maintenance, id: 'retention', everyMs: 3_600_000, jobName: 'retention' },
    { queue: QUEUE.maintenance, id: 'webhook-sweep', everyMs: 60_000, jobName: 'webhook-sweep' },
    { queue: QUEUE.maintenance, id: 'media-purge', everyMs: 3_600_000, jobName: 'media-purge' },
    { queue: QUEUE.maintenance, id: 'catalog-check', everyMs: 86_400_000, jobName: 'catalog-check' },
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
