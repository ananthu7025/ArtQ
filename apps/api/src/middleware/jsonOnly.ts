import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * State-changing requests that carry a body must be application/json (architecture.md §5.5), so plain HTML
 * forms (urlencoded, multipart, text/plain) cannot reach them. Webhook routes are mounted before this.
 */
export const jsonOnly: RequestHandler = (req, _res, next) => {
  if (!MUTATING.has(req.method)) return next();
  const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
  if (hasBody && !req.is('application/json')) {
    return next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Request body must be application/json'));
  }
  next();
};
