// Admin feature routes (architecture.md §5.9): one factory wires authentication, the per-admin rate limit and the audit
// guarantees for every /v1/admin/* feature router, so a module cannot forget them.
//
//   const admin = createAdminRouter(deps);
//   admin.routes.patch('/variants/:id/pricing', admin.can('pricing:write'), validate({ body: pricingSchema }), handler);
//   app routes: [..., admin.router]
//
// Inside a handler, record the change in the same transaction: `await recordAudit(tx, req, res, {...})`.
import { can, STEP_UP_PERMISSIONS, type Permission } from '@artq/shared';
import { Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express';
import type { Logger } from 'pino';
import { adminUserLimit } from '../auth/admin-routes.js';
import { requireAdmin, requireStepUp, type AuthDeps } from '../auth/middleware.js';
import type { Db } from '../db/functions.js';
import { AppError } from '../lib/errors.js';
import type { RateLimiter } from '../middleware/rateLimit.js';

export type AuditEntry = { action: string; entity: string; entityId?: string | number | null; before?: unknown; after?: unknown };

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Writes an audit row attributed to the request's admin; use inside the transaction that makes the change. */
export async function recordAudit(db: Db, req: Request, res: Response, e: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId: req.auth?.userId ?? null, sessionId: req.auth?.sessionId ?? null, action: e.action, entity: e.entity,
      entityId: e.entityId === undefined || e.entityId === null ? null : String(e.entityId),
      ...(e.before === undefined ? {} : { before: e.before as object }), ...(e.after === undefined ? {} : { after: e.after as object }),
      ip: req.ip ?? null, userAgent: req.get('user-agent')?.slice(0, 500) ?? null,
    },
  });
  res.locals.audited = true;
}

/** For a POST that changes nothing (a calculation such as the shipping preview): nothing to audit. */
export function markReadOnly(res: Response): void {
  res.locals.audited = true;
}

/** Codes of rejected admin requests that are security-relevant attempts (AT-10: "audit records attempts"). */
const AUDITED_REJECTIONS = new Set(['FORBIDDEN', 'STEP_UP_REQUIRED', 'VALIDATION_ERROR']);

export type AdminRouterDeps = AuthDeps & {
  limiter: RateLimiter;
  hasRecentStepUp: (sessionId: string) => Promise<boolean>;
  log: Logger;
  onRateLimitError?: (e: unknown) => void;
  /** Called when a successful admin mutation recorded no audit entry (defaults to an error log). */
  onMissingAudit?: (req: Request) => void;
};

export function createAdminRouter(d: AdminRouterDeps) {
  const routes = Router();
  const stepUp = requireStepUp(d.hasRecentStepUp);

  /** Role check for one permission; step-up is added for STEP_UP_PERMISSIONS or when `stepUp` is set. */
  const canDo = (permission: Permission, opts: { stepUp?: boolean } = {}): RequestHandler => {
    const needsStepUp = opts.stepUp ?? STEP_UP_PERMISSIONS.includes(permission);
    return (req, res, next) => {
      if (!req.auth || !can(req.auth.role, permission)) {
        return next(new AppError(403, 'FORBIDDEN', 'You do not have permission to do this', { permission }));
      }
      return needsStepUp ? stepUp(req, res, next) : next();
    };
  };

  /** Every successful state-changing admin request must have recorded an audit entry. */
  const auditTrail: RequestHandler = (req, res, next) => {
    if (!SAFE.has(req.method)) {
      res.on('finish', () => {
        // A replayed idempotent request repeats a stored answer and changes nothing: there is nothing new to audit.
        if (res.statusCode < 400 && !res.locals.audited && res.get('Idempotent-Replayed') !== 'true') {
          if (d.onMissingAudit) d.onMissingAudit(req);
          else d.log.error({ method: req.method, path: req.originalUrl, actorId: req.auth?.userId }, 'admin mutation without an audit entry');
        }
      });
    }
    next();
  };

  /** Denied and malformed admin requests are recorded (field paths and codes only, never submitted values). */
  const auditRejections: ErrorRequestHandler = async (err, req, _res, next) => {
    if (err instanceof AppError && req.auth && AUDITED_REJECTIONS.has(err.code)) {
      try {
        await d.prisma.auditLog.create({
          data: {
            actorId: req.auth.userId, sessionId: req.auth.sessionId, action: 'security.admin_rejected', entity: 'request',
            entityId: null, after: { code: err.code, method: req.method, path: req.originalUrl.split('?')[0], details: err.details ?? null } as object,
            ip: req.ip ?? null, userAgent: req.get('user-agent')?.slice(0, 500) ?? null,
          },
        });
      } catch (e) {
        d.log.error({ err: String(e) }, 'could not record a rejected admin request');
      }
    }
    next(err);
  };

  const router = Router();
  router.use('/admin', requireAdmin(d), adminUserLimit(d.limiter, d.onRateLimitError), auditTrail, routes, auditRejections);
  return { router, routes, can: canDo };
}
