import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { createApp } from './app.js';
import { ConfigError, loadEnv } from './config/env.js';
import { makeReadinessChecks } from './lib/readiness.js';

let env;
try { env = loadEnv(); }
catch (e) {
  if (e instanceof ConfigError) { console.error(e.message); process.exit(1); }
  throw e;
}

const log = pino({ name: 'api', level: env.LOG_LEVEL });
const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
redis.on('error', (err) => log.warn({ err: err.message }, 'redis connection error'));

const app = createApp({
  version: env.APP_VERSION,
  corsOrigins: env.CORS_ORIGINS,
  log,
  readiness: makeReadinessChecks(prisma, redis),
});

const server = app.listen(env.PORT, () => log.info({ port: env.PORT }, 'api listening'));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info({ sig }, 'shutting down');
    server.close(async () => { await prisma.$disconnect(); redis.disconnect(); process.exit(0); });
  });
}
