// Durable webhook inbox (architecture.md §8.1, database.md §8.6).
//   HTTP: verify the signature on the raw body → INSERT … ON CONFLICT DO NOTHING → COMMIT → 200 (503 if the DB failed);
//         best-effort enqueue of `wh-<id>`; the sweeper is the guarantee.
//   Worker: aq_webhook_claim (lease) → handler.fetch outside any TX (renewing the lease) →
//           TX aq_webhook_begin → handler.apply → aq_webhook_complete (LEASE_LOST rolls the domain change back);
//           failures → fenced aq_webhook_fail (backoff 30 s × 2ⁿ, DEAD + WEBHOOK_DEAD after 10 attempts).
import type { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { Router, type Request } from 'express';
import type { Logger } from 'pino';
import { DbFunctionError } from '../db/errors.js';
import * as fn from '../db/functions.js';
import { AppError } from '../lib/errors.js';
import type { InboxEvent, WebhookProvider } from './provider.js';

export const WEBHOOK_QUEUE = 'webhook.process';
export const WEBHOOK_LEASE_S = 300;
export const WEBHOOK_RENEW_MS = 60_000;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { rawBody?: Buffer }
  }
}

/** Job ids are fixed per row (`wh-<id>`); jobs are removed on completion so the sweeper can re-enqueue retries. */
export async function enqueueWebhook(queue: Pick<Queue, 'add'>, id: number): Promise<void> {
  await queue.add('webhook.process', { id }, { jobId: `wh-${id}`, removeOnComplete: true, removeOnFail: { age: 30 * 86_400 } });
}

export type InboxDeps = { prisma: PrismaClient; queue: Pick<Queue, 'add'> | null; providers: WebhookProvider[]; log: Logger };

export function webhookRouter(d: InboxDeps): Router {
  const r = Router();
  const bySlug = new Map(d.providers.map((p) => [p.slug, p]));
  r.post('/webhooks/:provider', async (req: Request, res) => {
    const p = bySlug.get(String(req.params.provider));
    if (!p) throw new AppError(404, 'NOT_FOUND', 'Unknown webhook provider');
    if (!p.verify) throw new AppError(503, 'WEBHOOK_NOT_CONFIGURED', 'Webhook receiver is not configured');
    if (!req.rawBody || !p.verify(req.rawBody, req.headers)) {
      d.log.warn({ provider: p.name, ip: req.ip }, 'webhook signature rejected');
      throw new AppError(400, 'INVALID_SIGNATURE', 'Signature verification failed');            // never stored
    }
    const eventId = p.eventId(req.headers, req.body);
    const eventType = p.eventType(req.body);
    if (!eventId || eventId.length > 120 || !eventType || eventType.length > 80) throw new AppError(400, 'VALIDATION_ERROR', 'Missing event id or type');

    let row: { id: number; status: string; due: boolean };
    try {
      const inserted = await d.prisma.$queryRaw<{ id: number }[]>`
        INSERT INTO webhook_events (provider, event_id, event_type, payload, provider_created_at)
        VALUES (${p.name}, ${eventId}, ${eventType}, ${JSON.stringify(req.body)}::jsonb, ${p.createdAt(req.body)}::timestamptz)
        ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`;
      const [existing] = await d.prisma.$queryRaw<{ id: number; status: string; due: boolean }[]>`
        SELECT id, status::text,
               (status IN ('RECEIVED', 'FAILED') OR (status = 'PROCESSING' AND locked_until < now())) AS due
          FROM webhook_events WHERE provider = ${p.name} AND event_id = ${eventId}`;
      row = existing!;
      if (inserted.length === 0) d.log.info({ provider: p.name, eventId, status: row.status }, 'duplicate webhook delivery');
    } catch (e) {
      d.log.error({ provider: p.name, eventId, err: String(e) }, 'webhook could not be stored');
      throw new AppError(503, 'UNAVAILABLE', 'Temporarily unable to accept the webhook');       // the provider retries
    }
    // Committed: from here the event cannot be lost. Enqueue is best effort (the sweeper re-enqueues).
    if (row.due && d.queue) {
      try { await enqueueWebhook(d.queue, row.id); } catch (e) { d.log.warn({ id: row.id, err: String(e) }, 'webhook enqueue failed; sweeper will retry'); }
    }
    res.status(200).json({ received: true });
  });
  return r;
}

export type ProcessDeps = { prisma: PrismaClient; providers: WebhookProvider[]; log: Logger; renewMs?: number; leaseS?: number };
export type ProcessResult = 'PROCESSED' | 'IGNORED' | 'NOT_CLAIMED' | 'FAILED' | 'DEAD' | 'LEASE_LOST';

class LeaseLostError extends Error { constructor() { super('webhook lease lost'); this.name = 'LeaseLostError'; } }

export async function processWebhook(d: ProcessDeps, id: number): Promise<ProcessResult> {
  const token = await fn.webhookClaim(d.prisma, id, d.leaseS ?? WEBHOOK_LEASE_S);
  if (!token) return 'NOT_CLAIMED';                                     // done, not due, or another worker holds the lease
  const row = await d.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
  const ev: InboxEvent = { id, provider: row.provider, eventId: row.eventId, eventType: row.eventType, payload: row.payload };
  const handler = d.providers.find((p) => p.name === row.provider)?.handlers[row.eventType];

  const abort = new AbortController();
  const timer = setInterval(() => {
    fn.webhookRenew(d.prisma, id, token, d.leaseS ?? WEBHOOK_LEASE_S)
      .then((ok) => { if (!ok) abort.abort(new LeaseLostError()); })
      .catch((e: unknown) => d.log.warn({ id, err: String(e) }, 'webhook lease renewal failed'));
  }, d.renewMs ?? WEBHOOK_RENEW_MS);
  try {
    const fetched = handler ? await handler.fetch(ev, { signal: abort.signal }) : null;
    if (abort.signal.aborted) throw new LeaseLostError();
    return await d.prisma.$transaction(async (tx) => {
      if (!(await fn.webhookBegin(tx, id, token))) throw new LeaseLostError();
      const final = handler ? ((await handler.apply(tx, fetched, ev)) ?? 'PROCESSED') : 'IGNORED';
      await fn.webhookComplete(tx, id, token, final);                     // raises LEASE_LOST ⇒ everything above rolls back
      return final;
    }, { maxWait: 10_000, timeout: 60_000 });
  } catch (e) {
    if (e instanceof LeaseLostError || (e instanceof DbFunctionError && e.code === 'LEASE_LOST')) {
      d.log.warn({ id }, 'webhook lease lost; a newer worker owns the event');
      return 'LEASE_LOST';
    }
    const outcome = await fn.webhookFail(d.prisma, id, token, (e instanceof Error ? e.message : String(e)).slice(0, 1000));
    d.log.warn({ id, provider: row.provider, eventType: row.eventType, outcome, err: String(e) }, 'webhook processing failed');
    return outcome;
  } finally {
    clearInterval(timer);
  }
}

/** Sweeper (every minute): re-enqueue rows that are due, or whose processing lease expired. Returns the ids. */
export async function sweepWebhooks(prisma: PrismaClient, queue: Pick<Queue, 'add'>, limit = 500): Promise<number[]> {
  const rows = await prisma.$queryRaw<{ id: number }[]>`
    SELECT id FROM webhook_events
     WHERE (status IN ('RECEIVED', 'FAILED') AND next_attempt_at <= now()) OR (status = 'PROCESSING' AND locked_until < now())
     ORDER BY id LIMIT ${limit}::int`;
  for (const r of rows) await enqueueWebhook(queue, r.id);
  return rows.map((r) => r.id);
}
