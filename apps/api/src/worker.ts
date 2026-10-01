import { Redis } from 'ioredis';
import { pino } from 'pino';
import { ConfigError, loadEnv } from './config/env.js';
import { QUEUE } from './jobs/registry.js';
import { createWorkerRuntime } from './worker/runtime.js';

let env;
try { env = loadEnv(); }
catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(1); } throw e; }

const log = pino({ name: 'worker', level: env.LOG_LEVEL });
const u = new URL(env.REDIS_URL);
const connection = { host: u.hostname, port: Number(u.port || 6379), ...(u.password ? { password: decodeURIComponent(u.password) } : {}), maxRetriesPerRequest: null };
const redis = new Redis(env.REDIS_URL);
redis.on('error', (err) => log.warn({ err: err.message }, 'redis connection error'));

// Phase 0 queues: a heartbeat proves the scheduler path. Real queues (outbox, webhooks, email…) arrive in Phase 1.
const runtime = createWorkerRuntime({
  connection, log,
  queues: [{ name: QUEUE.maintenance, concurrency: 1, processor: async () => { await redis.set('worker:heartbeat', new Date().toISOString(), 'EX', 300); return 'ok'; } }],
  schedulers: [{ queue: QUEUE.maintenance, id: 'heartbeat', everyMs: 60_000, jobName: 'heartbeat' }],
});
await runtime.start();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => { log.info({ sig }, 'worker shutting down'); await runtime.stop(); redis.disconnect(); process.exit(0); });
}
