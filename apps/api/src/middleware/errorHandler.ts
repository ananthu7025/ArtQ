import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { AppError } from '../lib/errors.js';

export const notFound: RequestHandler = (req, _res, next) => next(new AppError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`));

/** Maps every error to { error: { code, message, details? } }. Never leaks internals for 5xx. */
export function errorHandler(log: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    let e: AppError;
    if (err instanceof AppError) e = err;
    else if (err?.type === 'entity.parse.failed') e = new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
    else if (err?.type === 'entity.too.large') e = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    else if (err?.message === 'CORS_ORIGIN_NOT_ALLOWED') e = new AppError(403, 'ORIGIN_REJECTED', 'Request origin is not allowed');
    else e = new AppError(500, 'INTERNAL', 'Something went wrong');
    if (e.status >= 500) log.error({ err, requestId: req.id }, 'unhandled error');
    res.status(e.status).set('Cache-Control', 'no-store').json({ error: { code: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) } });
  };
}
