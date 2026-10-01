import cors from 'cors';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import { pino, type Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { jsonOnly } from './middleware/jsonOnly.js';
import { originPolicy, type OriginLists } from './middleware/originGuard.js';
import { RATE_LIMITS, rateLimit, type RateLimiter } from './middleware/rateLimit.js';
import { requestId } from './middleware/requestId.js';
import { healthRouter, type ReadinessChecks } from './routes/health.js';

export type AppDeps = {
  version: string;
  /** Allowed browser origins: storefront routes vs `/v1/admin/*` (architecture.md §5.5). CORS allows their union. */
  origins: OriginLists;
  /** Enables the default per-IP limit (api.md §6); routes add their own limits with the same limiter. */
  rateLimiter?: RateLimiter;
  onRateLimitError?: (e: unknown) => void;
  readiness: ReadinessChecks;
  readinessTimeoutMs?: number;
  log?: Logger;
  /** Routes mounted under /v1 (feature modules add theirs here). */
  routes?: Router[];
};

// Middleware order follows architecture.md §4. Cart token and idempotency arrive with their tasks.
export function createApp(deps: AppDeps): Express {
  const log = deps.log ?? pino({ level: 'silent' });
  const allowed = new Set([...deps.origins.storefront, ...deps.origins.admin]);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(requestId);
  app.use(pinoHttp({ logger: log, genReqId: (req) => (req as express.Request).id, autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false } }));
  app.use(helmet());
  // CORS only tells browsers what they may read; it is NOT authorization (originGuard enforces server-side).
  app.use(cors({
    origin: (origin, cb) => (!origin || allowed.has(origin) ? cb(null, origin ?? false) : cb(new Error('CORS_ORIGIN_NOT_ALLOWED'))),
    credentials: true,
    maxAge: 600,
  }));
  app.use(originPolicy(deps.origins));
  if (deps.rateLimiter) {
    const limiter = deps.rateLimiter;
    const onError = deps.onRateLimitError;
    const byIp = rateLimit({ limiter, name: 'default', rule: RATE_LIMITS.default, ...(onError ? { onError } : {}) });
    app.use((req, res, next) => (req.path.startsWith('/health') ? next() : byIp(req, res, next)));
  }
  app.use(jsonOnly);
  app.use(express.json({ limit: '1mb', type: 'application/json' }));
  app.use(healthRouter(deps.version, deps.readiness, deps.readinessTimeoutMs));
  for (const r of deps.routes ?? []) app.use('/v1', r);
  app.use(notFound);
  app.use(errorHandler(log));
  return app;
}
