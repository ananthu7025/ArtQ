import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { AppError } from '../lib/errors.js';

type Schemas = { body?: ZodType; query?: ZodType; params?: ZodType };

/** Validates and replaces body/query/params with the parsed values. Use strict schemas so unknown keys fail. */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    const details: { location: string; path: string; message: string }[] = [];
    const parsed: Record<string, unknown> = {};
    for (const loc of ['body', 'query', 'params'] as const) {
      const schema = schemas[loc];
      if (!schema) continue;
      const r = schema.safeParse(req[loc] ?? {});
      if (r.success) parsed[loc] = r.data;
      else for (const i of r.error.issues) details.push({ location: loc, path: i.path.join('.'), message: i.message });
    }
    if (details.length) return next(new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details));
    if ('body' in parsed) req.body = parsed.body;
    if ('params' in parsed) req.params = parsed.params as typeof req.params;
    if ('query' in parsed) Object.defineProperty(req, 'query', { value: parsed.query, writable: true });
    next();
  };
}
