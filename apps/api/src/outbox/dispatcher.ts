// Outbox dispatcher (architecture.md §8.2, database.md §8.7). No PostgreSQL transaction is open while it talks to Redis:
//   claim (short TX, fenced leases) → queue.add with a deterministic job id (no TX) → fenced mark-published (short TX).
// A dispatcher that dies between add and ack leaves the delivery LEASED; after the 30 s lease it is reclaimed as the next
// generation and published again, and the consumer's begin/complete dedupe absorbs the duplicate job.
import type { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import * as fn from '../db/functions.js';
import { jobId } from '../jobs/ids.js';

/** Every consumer named in aq_emit calls (migration 0003 + services) → its BullMQ queue. Workers arrive with their tasks. */
export const OUTBOX_CONSUMERS = {
  'email.customer': 'email.customer',     // task 1.8
  'email.admin': 'email.admin',           // task 1.8
  'notify.admin': 'notify.admin',         // admin notifications (Phase 2 dashboard)
  'invoice.credit_note': 'invoice.credit_note', // Phase 5
  'refund.send': 'refund.send',           // Phase 5
  'restock.notify': 'restock.notify',     // Phase 3/4
} as const;
export type OutboxConsumer = keyof typeof OUTBOX_CONSUMERS;

export const DISPATCH = { limit: 100, leaseSeconds: 30, redeliverSeconds: 1800, maxGenerations: 10 } as const;

export type OutboxJobData = { deliveryId: number; eventId: number; generation: number };

export type DispatchDeps = {
  prisma: PrismaClient;
  /** Queue by consumer name. */
  queues: ReadonlyMap<string, Queue>;
  log: Logger;
  /** Test hook: runs after queue.add and before the ack (simulates a crash when it throws). */
  afterAdd?: (deliveryId: number) => void | Promise<void>;
};

export type DispatchResult = { claimed: number; published: number; failed: number; leaseLost: number };

export async function dispatchOnce(d: DispatchDeps, opts: Partial<typeof DISPATCH> = {}): Promise<DispatchResult> {
  const o = { ...DISPATCH, ...opts };
  const rows = await fn.outboxClaim(d.prisma, { limit: o.limit, leaseSeconds: o.leaseSeconds, redeliverSeconds: o.redeliverSeconds, maxGenerations: o.maxGenerations });
  const r: DispatchResult = { claimed: rows.length, published: 0, failed: 0, leaseLost: 0 };
  for (const row of rows) {
    const queueName = (OUTBOX_CONSUMERS as Record<string, string>)[row.consumer];
    const queue = queueName ? d.queues.get(queueName) : undefined;
    try {
      if (!queue) throw new Error(`no queue for outbox consumer "${row.consumer}"`);
      const data: OutboxJobData = { deliveryId: row.deliveryId, eventId: row.eventId, generation: row.generation };
      await queue.add(row.eventType, data, { jobId: jobId('outbox', row.deliveryId, row.generation) });
    } catch (e) {
      const ok = await fn.outboxPublishFailed(d.prisma, row.deliveryId, row.leaseToken, String(e instanceof Error ? e.message : e).slice(0, 500));
      if (ok) r.failed++; else r.leaseLost++;
      d.log.warn({ deliveryId: row.deliveryId, consumer: row.consumer, err: String(e) }, 'outbox publish failed');
      continue;
    }
    await d.afterAdd?.(row.deliveryId);
    if (await fn.outboxMarkPublished(d.prisma, row.deliveryId, row.leaseToken)) r.published++;
    else r.leaseLost++;                    // a newer owner republished it; the consumer dedupes
  }
  return r;
}
