import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection for cookie-authenticated routes (architecture.md §5.5). CORS is not authorization:
 * this runs server-side for every state-changing request regardless of CORS.
 */
export function originGuard(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.header('origin');
    if (!origin || !allowed.has(origin)) {
      return next(new AppError(403, 'ORIGIN_REJECTED', 'Request origin is not allowed'));
    }
    const site = req.header('sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && site !== 'same-site') {
      return next(new AppError(403, 'ORIGIN_REJECTED', 'Cross-site request rejected'));
    }
    next();
  };
}
