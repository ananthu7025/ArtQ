import cors from 'cors';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import { pino, type Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { jsonOnly } from './middleware/jsonOnly.js';
import { requestId } from './middleware/requestId.js';
import { healthRouter, type ReadinessChecks } from './routes/health.js';

export type AppDeps = {
  version: string;
  corsOrigins: readonly string[];
  readiness: ReadinessChecks;
  readinessTimeoutMs?: number;
  log?: Logger;
  /** Routes mounted under /v1 (feature modules add theirs here). */
  routes?: Router[];
};

// Middleware order follows architecture.md §4. Auth, rate limiting, cart token and idempotency arrive with their tasks.
export function createApp(deps: AppDeps): Express {
  const log = deps.log ?? pino({ level: 'silent' });
  const allowed = new Set(deps.corsOrigins);
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
  app.use(jsonOnly);
  app.use(express.json({ limit: '1mb', type: 'application/json' }));
  app.use(healthRouter(deps.version, deps.readiness, deps.readinessTimeoutMs));
  for (const r of deps.routes ?? []) app.use('/v1', r);
  app.use(notFound);
  app.use(errorHandler(log));
  return app;
}
