import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { createApp } from './app.js';
import { authRouter } from './auth/routes.js';
import { DEFAULT_AUTH_TIMINGS, AuthService } from './auth/service.js';
import { RedisSessionCache } from './auth/session-cache.js';
import { ConfigError, loadEnv } from './config/env.js';
import { makeReadinessChecks } from './lib/readiness.js';
import { RedisRateLimiter } from './middleware/rateLimit.js';

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

const jwt = { secret: new TextEncoder().encode(env.AUTH_JWT_SECRET), issuer: env.AUTH_JWT_ISSUER };
const cache = new RedisSessionCache(redis, 60, (op, err) => log.warn({ op, err: String(err) }, 'session cache unavailable'));
const service = new AuthService(prisma, cache, {
  ...DEFAULT_AUTH_TIMINGS, jwt, otpPepper: env.AUTH_OTP_PEPPER, linkSecret: env.AUTH_LINK_SECRET, webUrl: env.WEB_URL,
});

const limiter = new RedisRateLimiter(redis);
const onRateLimitError = (err: unknown) => log.warn({ err: String(err) }, 'rate limiter unavailable; request allowed');

const app = createApp({
  version: env.APP_VERSION,
  origins: { storefront: env.STOREFRONT_ORIGINS, admin: env.ADMIN_ORIGINS },
  log,
  readiness: makeReadinessChecks(prisma, redis),
  rateLimiter: limiter,
  onRateLimitError,
  routes: [authRouter({ prisma, cache, jwt, service, env: env.NODE_ENV, refreshMaxAgeS: DEFAULT_AUTH_TIMINGS.refreshIdleS, limiter, onRateLimitError })],
});

const server = app.listen(env.PORT, () => log.info({ port: env.PORT }, 'api listening'));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info({ sig }, 'shutting down');
    server.close(async () => { await prisma.$disconnect(); redis.disconnect(); process.exit(0); });
  });
}
