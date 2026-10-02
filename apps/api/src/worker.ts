import { PrismaClient } from '@prisma/client';
import type { Job } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { ConfigError, loadEnv } from './config/env.js';
import { processEmailDelivery, type EmailConsumer } from './email/consumer.js';
import { ResendTransport, SmtpTransport, type EmailTransport } from './email/transport.js';
import { QUEUE } from './jobs/registry.js';
import { runRetention } from './jobs/retention.js';
import { dispatchOnce, OUTBOX_CONSUMERS, type OutboxJobData } from './outbox/dispatcher.js';
import { createWorkerRuntime } from './worker/runtime.js';

let env;
try { env = loadEnv(); }
catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(1); } throw e; }

const log = pino({ name: 'worker', level: env.LOG_LEVEL });
const u = new URL(env.REDIS_URL);
const connection = { host: u.hostname, port: Number(u.port || 6379), ...(u.password ? { password: decodeURIComponent(u.password) } : {}), maxRetriesPerRequest: null };
const redis = new Redis(env.REDIS_URL);
redis.on('error', (err) => log.warn({ err: err.message }, 'redis connection error'));
const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });

const transport: EmailTransport = env.EMAIL_TRANSPORT === 'resend'
  ? new ResendTransport({ apiKey: env.RESEND_API_KEY! })
  : new SmtpTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT });
const email = (consumer: EmailConsumer) => async (job: Job<OutboxJobData>) =>
  processEmailDelivery({ prisma, transport, from: env.EMAIL_FROM, log }, consumer, job.data.deliveryId);

const runtime = createWorkerRuntime({
  connection, log,
  queues: [
    { name: QUEUE.maintenance, concurrency: 1, processor: async (job) => {
      if (job.name === 'retention') return runRetention(prisma);
      await redis.set('worker:heartbeat', new Date().toISOString(), 'EX', 300);
      return 'ok';
    } },
    // One dispatch at a time per process; several processes are safe (SKIP LOCKED + fenced leases).
    { name: QUEUE.outboxDispatch, concurrency: 1, attempts: 1, processor: async () => dispatchOnce({ prisma, queues: runtime.queues, log }) },
    { name: OUTBOX_CONSUMERS['email.customer'], concurrency: 5, processor: email('email.customer') },
    { name: OUTBOX_CONSUMERS['email.admin'], concurrency: 2, processor: email('email.admin') },
  ],
  // Consumers implemented in later phases: their jobs wait in Redis (and PostgreSQL) until a worker exists.
  producers: Object.values(OUTBOX_CONSUMERS),
  schedulers: [
    { queue: QUEUE.maintenance, id: 'heartbeat', everyMs: 60_000, jobName: 'heartbeat' },
    { queue: QUEUE.maintenance, id: 'retention', everyMs: 3_600_000, jobName: 'retention' },
    { queue: QUEUE.outboxDispatch, id: 'outbox-dispatch', everyMs: 1000, jobName: 'dispatch' },
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
