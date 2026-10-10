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
import { RedisAppCache } from './lib/app-cache.js';
import { redisConnection } from './lib/redis-url.js';
import { jobId } from './jobs/ids.js';
import { BULLMQ_BASE, QUEUE } from './jobs/registry.js';
import { mediaServiceFromEnv, mediaStorageFromEnv } from './media/factory.js';
import { customerMediaRouter, registerAdminMediaRoutes } from './media/routes.js';
import { registerAuditRoutes } from './admin/audit-routes.js';
import { registerStaffRoutes } from './admin/staff-routes.js';
import { registerCatalogRoutes } from './catalog/routes.js';
import { CatalogService } from './catalog/service.js';
import { registerTaxonomyRoutes } from './catalog/taxonomy-routes.js';
import { importEnqueue } from './imports/queues.js';
import { registerImportRoutes } from './imports/routes.js';
import { registerInventoryRoutes } from './inventory/routes.js';
import { registerCouponRoutes } from './coupons/admin-routes.js';
import { registerOrderRoutes } from './orders/admin-routes.js';
import { DispatchService } from './orders/dispatch.js';
import { customerOrderRouter, registerCancelRoutes } from './orders/cancel.js';
import { registerCodRoutes } from './orders/cod.js';
import { registerCustomerRoutes } from './customers/admin.js';
import { registerDashboardRoutes } from './dashboard/routes.js';
import { registerCmsRoutes } from './cms/routes.js';
import { CmsService } from './cms/service.js';
import { registerRestockRoutes } from './restock/service.js';
import { registerOpsRoutes } from './ops/routes.js';
import { lastRunKey, OpsService } from './ops/service.js';
import { OUTBOX_CONSUMERS } from './outbox/dispatcher.js';
import { customerOrdersRouter } from './orders/customer-routes.js';
import { contentRouter } from './content/routes.js';
import { registerNewsletterRoutes } from './content/newsletter-admin.js';
import { registerRefundRoutes } from './payments/refund-admin.js';
import { customerReturnRouter, registerReturnRoutes } from './returns/routes.js';
import { registerShippingRoutes } from './shipping/admin-routes.js';
import { ImportService } from './imports/service.js';
import { razorpayProvider } from './webhooks/provider.js';
import { storefrontRouter } from './storefront/routes.js';
import { cartRouter, claimGuestCartOnSignIn } from './cart/routes.js';
import { RazorpayClient } from './payments/razorpay.js';
import { CheckoutService } from './checkout/initiate.js';
import { checkoutPaymentRouter } from './checkout/payment-routes.js';
import { CartService } from './cart/service.js';
import { accountRouter } from './account/routes.js';
import { enqueueWebhook, WEBHOOK_QUEUE, webhookRouter } from './webhooks/inbox.js';

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
const mediaUrl = (key: string) => `${env.MEDIA_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`;
/** Paying online needs the Razorpay keys; without them checkout offers COD only (the quote reports online payments off). */
const razorpay = env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET ? new RazorpayClient(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET) : null;
const appCache = new RedisAppCache(redis, (op, err) => log.warn({ op, err: String(err) }, 'app cache unavailable; reading from the database'));
const onRateLimitError = (err: unknown) => log.warn({ err: String(err) }, 'rate limiter unavailable; request allowed');

// Admin feature modules (Phase 2+) register on admin.routes; auth, rate limit and audit are wired by the factory.
const admin = createAdminRouter({ prisma, cache, jwt, limiter, onRateLimitError, log, hasRecentStepUp: (sid) => service.hasRecentStepUp(sid) });

const webhookQueue = new Queue(WEBHOOK_QUEUE, { ...BULLMQ_BASE, connection: { ...redisConnection(env.REDIS_URL), maxRetriesPerRequest: 1, enableOfflineQueue: false } });
webhookQueue.on('error', (err) => log.warn({ err: err.message }, 'webhook queue connection error'));
const mediaQueue = new Queue(QUEUE.mediaProcess, { ...BULLMQ_BASE, connection: webhookQueue.opts.connection });
mediaQueue.on('error', (err) => log.warn({ err: err.message }, 'media queue connection error'));
// A unique job id per enqueue: processing is claimed by a status transition, so a duplicate job is harmless.
const media = mediaServiceFromEnv(env, prisma, async (id) => { await mediaQueue.add('media.process', { id }, { jobId: jobId('media', id, Date.now()), attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: true }); });
registerAdminMediaRoutes(admin, media, prisma);
registerAuditRoutes(admin, prisma);
registerStaffRoutes(admin, prisma, service);
registerCatalogRoutes(admin, new CatalogService(prisma, (m) => media.view(m)));
registerTaxonomyRoutes(admin, prisma, (m) => media.view(m), appCache);
const importValidateQueue = new Queue(QUEUE.importValidate, { ...BULLMQ_BASE, connection: webhookQueue.opts.connection });
const importApplyQueue = new Queue(QUEUE.importApply, { ...BULLMQ_BASE, connection: webhookQueue.opts.connection });
for (const q of [importValidateQueue, importApplyQueue]) q.on('error', (err) => log.warn({ err: err.message, queue: q.name }, 'import queue connection error'));
registerInventoryRoutes(admin, prisma);
registerCouponRoutes(admin, prisma);
registerShippingRoutes(admin, prisma, appCache);
registerOrderRoutes(admin, prisma, new DispatchService(prisma, mediaStorageFromEnv(env)));
registerCancelRoutes(admin, prisma, log);
registerRefundRoutes(admin, prisma, log);
registerReturnRoutes(admin, prisma, log, media);
registerCodRoutes(admin, prisma);
registerCustomerRoutes(admin, prisma, service);
registerRestockRoutes(admin, prisma);
registerDashboardRoutes(admin, prisma);
registerNewsletterRoutes(admin, prisma, env.WEB_URL);
registerCmsRoutes(admin, new CmsService(prisma, (m) => media.view(m), appCache, mediaUrl), media);
// Jobs & Webhooks reads every queue (depths, failed jobs) on the API's Redis connection; the worker owns processing.
const opsQueues = new Map<string, Queue>([[webhookQueue.name, webhookQueue], [mediaQueue.name, mediaQueue], [importValidateQueue.name, importValidateQueue], [importApplyQueue.name, importApplyQueue]]);
for (const name of [QUEUE.maintenance, QUEUE.outboxDispatch, QUEUE.searchReindex, ...new Set(Object.values(OUTBOX_CONSUMERS))]) {
  if (opsQueues.has(name)) continue;
  const q = new Queue(name, { ...BULLMQ_BASE, connection: webhookQueue.opts.connection });
  q.on('error', (err) => log.warn({ err: err.message, queue: name }, 'ops queue connection error'));
  opsQueues.set(name, q);
}
registerOpsRoutes(admin, new OpsService({
  prisma, queues: opsQueues, provider: razorpay,
  readLastRuns: (names) => redis.mget(...names.map(lastRunKey)),
  enqueueWebhook: (id) => enqueueWebhook(webhookQueue, id),
}), log);
registerImportRoutes(admin, prisma, new ImportService({ prisma, readFile: (m) => media.read(m), enqueue: importEnqueue(importValidateQueue, importApplyQueue) }));

const app = createApp({
  version: env.APP_VERSION,
  origins: { storefront: env.STOREFRONT_ORIGINS, admin: env.ADMIN_ORIGINS },
  log,
  readiness: makeReadinessChecks(prisma, redis),
  rateLimiter: limiter,
  onRateLimitError,
  routes: [
    authRouter({ prisma, cache, jwt, service, env: env.NODE_ENV, refreshMaxAgeS: DEFAULT_AUTH_TIMINGS.refreshIdleS, limiter, onRateLimitError, onSignedIn: claimGuestCartOnSignIn({ prisma, env: env.NODE_ENV, mediaUrl }) }),
    adminAuthRouter({ prisma, cache, jwt, service, env: env.NODE_ENV, limiter, onRateLimitError }),
    customerMediaRouter({ prisma, cache, jwt }, media),
    cartRouter({ prisma, cache, jwt, env: env.NODE_ENV, mediaUrl, limiter, onRateLimitError, checkout: { provider: razorpay, storeName: 'ArtQ', log } }),
    checkoutPaymentRouter({ prisma, cache, jwt, env: env.NODE_ENV, provider: razorpay, log, limiter, onRateLimitError, links: { webUrl: env.WEB_URL, linkSecret: env.AUTH_LINK_SECRET, setPasswordTtlS: DEFAULT_AUTH_TIMINGS.setPasswordTtlS }, checkout: new CheckoutService({ prisma, carts: new CartService(prisma, mediaUrl), provider: razorpay, mediaUrl, storeName: 'ArtQ' }) }),
    accountRouter({ prisma, cache, jwt, service, env: env.NODE_ENV, mediaUrl, limiter, onRateLimitError }),
    customerOrderRouter({ prisma, cache, jwt, log }),
    customerReturnRouter({ prisma, cache, jwt, log, media }),
    contentRouter({ prisma, cache, jwt, env: env.NODE_ENV, log, media, mediaUrl, limiter, onRateLimitError }),
    customerOrdersRouter({ prisma, cache, jwt, log, env: env.NODE_ENV, linkSecret: env.AUTH_LINK_SECRET, auth: service, media, dispatch: new DispatchService(prisma, mediaStorageFromEnv(env)), limiter, onRateLimitError }),
    storefrontRouter({ prisma, cache: appCache, mediaUrl, limiter, onRateLimitError, onInvalidSetting: (key) => log.warn({ key }, 'stored setting is invalid; serving the default'), onSearchLogError: (err) => log.warn({ err: String(err) }, 'search log not written') }),
    webhookRouter({ prisma, queue: webhookQueue, providers: [razorpayProvider(env.RAZORPAY_WEBHOOK_SECRET || undefined)], log }),
    admin.router,
  ],
});

const server = app.listen(env.PORT, () => log.info({ port: env.PORT }, 'api listening'));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info({ sig }, 'shutting down');
    server.close(async () => { for (const q of opsQueues.values()) await q.close(); await prisma.$disconnect(); redis.disconnect(); process.exit(0); });
  });
}
