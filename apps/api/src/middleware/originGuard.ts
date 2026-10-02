import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection (architecture.md §5.5). CORS is not authorization: this runs server-side for every state-changing
 * request regardless of CORS. `Origin` must be present and exactly allow-listed; `Sec-Fetch-Site`, when sent, must be
 * same-origin or same-site.
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

export type OriginLists = { storefront: readonly string[]; admin: readonly string[] };

/**
 * App-wide policy so no route can forget it: every state-changing request must come from an allowed origin.
 * `/v1/admin/*` accepts only the admin origins, everything else only the storefront origins. Webhooks are exempt
 * (authenticated by provider signature, task 1.9). Stricter than "cookie routes only": the API has no non-browser
 * clients, and Bearer routes called from the SPAs always send Origin.
 */
export function originPolicy(origins: OriginLists): RequestHandler {
  const storefront = originGuard(origins.storefront);
  const admin = originGuard(origins.admin);
  return (req, res, next) => {
    // Express matches routes case-insensitively, so decide on the lower-cased path: `/V1/AUTH/login` must not slip past.
    const path = req.path.toLowerCase();
    if (/^\/v1\/webhooks(\/|$)/.test(path)) return next();
    return (/^\/v1\/admin(\/|$)/.test(path) ? admin : storefront)(req, res, next);
  };
}
