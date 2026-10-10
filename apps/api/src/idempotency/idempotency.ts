// Idempotency-Key handling (api.md §1.2, database.md §8.1). Every endpoint that must not run twice is wrapped:
//
//   r.post('/checkout/initiate', validate({ body }), idempotent(deps, {
//     operation: 'checkout.initiate', scope: (req) => …, target: (req) => `cart:${…}`,
//   }, async (req, ctx) => {
//     if (ctx.resume) …                                   // TAKEOVER: continue the attached resource, never recreate it
//     const order = await ctx.tx(async (tx) => { …; await ctx.attach(tx, 'order', orderNumber); return … });
//     await ctx.renew();                                  // before/while a slow provider call
//     return { status: 201, body, resource: { type: 'order', id: orderNumber } };
//   }));
//
// Ownership is fenced: ctx.tx starts every transaction with aq_idempotency_assert_owner, and attach/renew/complete
// carry the owner token. A request that lost ownership (another request took over after its lock expired) has its
// work rolled back and gets 409 REQUEST_SUPERSEDED; the client retries and receives the new owner's response.
import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Request, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { DbFunctionError } from '../db/errors.js';
import * as fn from '../db/functions.js';
import { AppError } from '../lib/errors.js';

export const IDEMPOTENCY_LOCK_S = 60;
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Canonical JSON: object keys sorted at every level, no insignificant whitespace, `undefined` members dropped. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new TypeError('non-finite number in idempotent body');
    return JSON.stringify(v) ?? 'null';
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** request_hash = SHA-256(canonical JSON {operation, target, scope, body}) (api.md §1.2). */
export function requestHash(p: { operation: string; target: string; scope: string; body: unknown }): string {
  return createHash('sha256').update(canonicalJson(p)).digest('hex');
}

export class SupersededError extends Error {
  constructor() { super('another request took over this idempotency key'); this.name = 'SupersededError'; }
}

const superseded = () => new AppError(409, 'REQUEST_SUPERSEDED', 'This request was superseded by a retry. Retry with the same Idempotency-Key to get its result.');

export type IdempotencyContext = {
  scope: string; operation: string; key: string; ownerToken: string; generation: number;
  /** Set on TAKEOVER when the previous owner had attached a resource: resume it instead of creating another. */
  resume: { resourceType: string; resourceId: string } | null;
  /** Runs a transaction whose first statement proves ownership. Throws SupersededError if ownership was lost. */
  tx<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  /** Records the resource created for this request (call inside ctx.tx, in the same transaction that created it). */
  attach(tx: Prisma.TransactionClient, resourceType: string, resourceId: string): Promise<void>;
  /** Extends the lock (default: the spec's lock) before/while a slow provider call. Throws SupersededError if a newer owner is in charge. */
  renew(lockSeconds?: number): Promise<void>;
};

export type IdempotentResult = {
  status: number; body: unknown; resource?: { type: string; id: string };
  /**
   * Answer without completing the key: it stays PROCESSING with a lock of `lockSeconds`, so a retry with the same key
   * soon after TAKES OVER and resumes (e.g. 202 PAYMENT_STARTING when the provider's outcome is unknown).
   */
  keepOpenSeconds?: number;
};

export type IdempotencySpec = {
  operation: string;
  scope: (req: Request) => string;
  target: (req: Request) => string;
  lockSeconds?: number;
};

export type IdempotencyDeps = { prisma: PrismaClient; log: Logger };

const isOwnershipLost = (e: unknown) => e instanceof SupersededError || (e instanceof DbFunctionError && e.code === 'IDEMPOTENCY_OWNERSHIP_LOST');

export function idempotent(d: IdempotencyDeps, spec: IdempotencySpec, handler: (req: Request, ctx: IdempotencyContext) => Promise<IdempotentResult>): RequestHandler {
  const lockSeconds = spec.lockSeconds ?? IDEMPOTENCY_LOCK_S;
  return async (req, res) => {
    const key = req.get('idempotency-key');
    if (!key || !KEY.test(key)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'An Idempotency-Key header (UUID) is required', [{ location: 'headers', path: 'idempotency-key', message: 'must be a UUID' }]);
    }
    const scope = spec.scope(req);
    const target = spec.target(req);
    const k = { scope, operation: spec.operation, key: key.toLowerCase() };
    const begin = await fn.idempotencyBegin(d.prisma, { ...k, target, requestHash: requestHash({ operation: spec.operation, target, scope, body: req.body ?? {} }), lockSeconds });

    if (begin.outcome === 'REPLAY') {
      res.status(begin.responseCode).set('Idempotent-Replayed', 'true').set('Cache-Control', 'no-store').json(begin.responseBody);
      return;
    }
    if (begin.outcome === 'IN_PROGRESS') {
      res.set('Retry-After', '2');
      throw new AppError(409, 'REQUEST_IN_PROGRESS', 'The same request is still being processed. Retry shortly.');
    }
    if (begin.outcome === 'CONFLICT') {
      throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
    }

    const token = begin.ownerToken;
    const ctx: IdempotencyContext = {
      ...k, ownerToken: token, generation: begin.generation,
      resume: begin.outcome === 'TAKEOVER' && begin.resourceType && begin.resourceId ? { resourceType: begin.resourceType, resourceId: begin.resourceId } : null,
      async tx(work) {
        try {
          return await d.prisma.$transaction(async (tx) => {
            await fn.idempotencyAssertOwner(tx, { ...k, ownerToken: token });          // first statement, always
            return work(tx);
          }, { maxWait: 10_000, timeout: 30_000 });
        } catch (e) {
          if (isOwnershipLost(e)) throw new SupersededError();
          throw e;
        }
      },
      async attach(tx, resourceType, resourceId) {
        await fn.idempotencyAttach(tx, { ...k, ownerToken: token, resourceType, resourceId });
      },
      async renew(seconds = lockSeconds) {
        if (!(await fn.idempotencyRenew(d.prisma, { ...k, ownerToken: token, lockSeconds: seconds }))) throw new SupersededError();
      },
    };

    let result: IdempotentResult;
    try {
      result = await handler(req, ctx);
    } catch (e) {
      if (isOwnershipLost(e)) throw superseded();
      if (e instanceof AppError && e.status < 500) {
        // Business outcome (OUT_OF_STOCK, COUPON_*, …): store it so a retry with the same key gets the same answer.
        const body = { error: { code: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) } };
        await complete(d, k, token, e.status, body, undefined);
        throw e;
      }
      // Unexpected failure: nothing was committed under the key ⇒ release it so an immediate retry runs; otherwise
      // keep it locked so the retry TAKES OVER and resumes the attached resource.
      await release(d.prisma, k, token).catch((err: unknown) => d.log.warn({ err: String(err) }, 'could not release idempotency key'));
      throw e;
    }
    if (result.keepOpenSeconds !== undefined) {
      try { await ctx.renew(result.keepOpenSeconds); } catch (e) { if (isOwnershipLost(e)) throw superseded(); throw e; }
    } else {
      await complete(d, k, token, result.status, result.body, result.resource);
    }
    res.status(result.status).set('Cache-Control', 'no-store').json(result.body);
  };
}

async function complete(d: IdempotencyDeps, k: { scope: string; operation: string; key: string }, token: string, status: number, body: unknown, resource: { type: string; id: string } | undefined) {
  try {
    await fn.idempotencyComplete(d.prisma, { ...k, ownerToken: token, responseCode: status, responseBody: body ?? null, resourceType: resource?.type ?? null, resourceId: resource?.id ?? null });
  } catch (e) {
    if (isOwnershipLost(e)) throw superseded();
    throw e;
  }
}

/** Deletes a PROCESSING key that this owner holds and that has no attached resource (fenced by the token). */
async function release(prisma: PrismaClient, k: { scope: string; operation: string; key: string }, token: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM idempotency_keys
     WHERE scope = ${k.scope} AND operation = ${k.operation} AND key = ${k.key} AND owner_token = ${token}::uuid
       AND status = 'PROCESSING' AND resource_id IS NULL`;
}
