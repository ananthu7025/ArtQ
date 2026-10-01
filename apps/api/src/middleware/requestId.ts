import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const SAFE = /^[A-Za-z0-9_-]{8,64}$/;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { id: string }
  }
}

/** Accepts a well-formed incoming X-Request-Id (from the edge), otherwise generates one; always echoes it. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.id = incoming && SAFE.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};
