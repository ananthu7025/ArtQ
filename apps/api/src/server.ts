import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { createApp } from './app.js';
import { createAdminRouter } from './admin/router.js';
import { adminAuthRouter } from './auth/admin-routes.js';
import { authRouter } from './auth/routes.js';
import { DEFAULT_AUTH_TIMINGS, AuthService } from './auth/service.js';
import { RedisSessionCache } from './auth/session-cache.js';
import { ConfigError, loadEnv } from './config/env.js';
import { makeReadinessChecks } from './lib/readiness.js';
import { RedisRateLimiter } from './middleware/rateLimit.js';
import { redisConnection } from './lib/redis-url.js';
import { jobId } from './jobs/ids.js';
import { QUEUE } from './jobs/registry.js';
import { mediaServiceFromEnv } from './media/factory.js';
import { customerMediaRouter, registerAdminMediaRoutes } from './media/routes.js';
import { registerAuditRoutes } from './admin/audit-routes.js';
import { registerStaffRoutes } from './admin/staff-routes.js';
import { registerCatalogRoutes } from './catalog/routes.js';
import { CatalogService } from './catalog/service.js';
import { registerTaxonomyRoutes } from './catalog/taxonomy-routes.js';
import { importEnqueue } from './imports/queues.js';
import { registerImportRoutes } from './imports/routes.js';
import { registerInventoryRoutes } from './inventory/routes.js';
import { ImportService } from './imports/service.js';
import { razorpayProvider } from './webhooks/provider.js';
import { storefrontRouter } from './storefront/routes.js';
import { WEBHOOK_QUEUE, webhookRouter } from './webhooks/inbox.js';

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
  adminUrl: env.ADMIN_ORIGINS[0]!,   // the first admin origin is where staff links point
});

const limiter = new RedisRateLimiter(redis);
const onRateLimitError = (err: unknown) => log.warn({ err: String(err) }, 'rate limiter unavailable; request allowed');

// Admin feature modules (Phase 2+) register on admin.routes; auth, rate limit and audit are wired by the factory.
const admin = createAdminRouter({ prisma, cache, jwt, limiter, onRateLimitError, log, hasRecentStepUp: (sid) => service.hasRecentStepUp(sid) });

const webhookQueue = new Queue(WEBHOOK_QUEUE, { connection: { ...redisConnection(env.REDIS_URL), maxRetriesPerRequest: 1, enableOfflineQueue: false } });
webhookQueue.on('error', (err) => log.warn({ err: err.message }, 'webhook queue connection error'));
const mediaQueue = new Queue(QUEUE.mediaProcess, { connection: webhookQueue.opts.connection });
mediaQueue.on('error', (err) => log.warn({ err: err.message }, 'media queue connection error'));
// A unique job id per enqueue: processing is claimed by a status transition, so a duplicate job is harmless.
const media = mediaServiceFromEnv(env, prisma, async (id) => { await mediaQueue.add('media.process', { id }, { jobId: jobId('media', id, Date.now()), attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: true }); });
registerAdminMediaRoutes(admin, media, prisma);
registerAuditRoutes(admin, prisma);
registerStaffRoutes(admin, prisma, service);
registerCatalogRoutes(admin, new CatalogService(prisma, (m) => media.view(m)));
registerTaxonomyRoutes(admin, prisma, (m) => media.view(m));
const importValidateQueue = new Queue(QUEUE.importValidate, { connection: webhookQueue.opts.connection });
const importApplyQueue = new Queue(QUEUE.importApply, { connection: webhookQueue.opts.connection });
for (const q of [importValidateQueue, importApplyQueue]) q.on('error', (err) => log.warn({ err: err.message, queue: q.name }, 'import queue connection error'));
registerInventoryRoutes(admin, prisma);
registerImportRoutes(admin, prisma, new ImportService({ prisma, readFile: (m) => media.read(m), enqueue: importEnqueue(importValidateQueue, importApplyQueue) }));

const app = createApp({
  version: env.APP_VERSION,
  origins: { storefront: env.STOREFRONT_ORIGINS, admin: env.ADMIN_ORIGINS },
  log,
  readiness: makeReadinessChecks(prisma, redis),
  rateLimiter: limiter,
  onRateLimitError,
  routes: [
    authRouter({ prisma, cache, jwt, service, env: env.NODE_ENV, refreshMaxAgeS: DEFAULT_AUTH_TIMINGS.refreshIdleS, limiter, onRateLimitError }),
    adminAuthRouter({ prisma, cache, jwt, service, env: env.NODE_ENV, limiter, onRateLimitError }),
    customerMediaRouter({ prisma, cache, jwt }, media),
    storefrontRouter({ prisma, limiter, onRateLimitError, onInvalidSetting: (key) => log.warn({ key }, 'stored setting is invalid; serving the default') }),
    webhookRouter({ prisma, queue: webhookQueue, providers: [razorpayProvider(env.RAZORPAY_WEBHOOK_SECRET || undefined)], log }),
    admin.router,
  ],
});

const server = app.listen(env.PORT, () => log.info({ port: env.PORT }, 'api listening'));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info({ sig }, 'shutting down');
    server.close(async () => { await importValidateQueue.close(); await importApplyQueue.close(); await mediaQueue.close(); await webhookQueue.close(); await prisma.$disconnect(); redis.disconnect(); process.exit(0); });
  });
}
