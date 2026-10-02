// Consumer side of the outbox (architecture.md §8.3). The delivery row is the durable dedupe: every consumer starts with
// aq_outbox_begin_consume (false ⇒ already COMPLETED/DEAD ⇒ acknowledge and do nothing) and ends with aq_outbox_complete.
import type { Prisma, PrismaClient } from '@prisma/client';
import * as fn from '../db/functions.js';

export type OutboxEventRow = { deliveryId: number; consumer: string; eventId: number; eventType: string; aggregateType: string; aggregateId: string; payload: unknown };

export async function loadDelivery(db: PrismaClient | Prisma.TransactionClient, deliveryId: number): Promise<OutboxEventRow | null> {
  const [r] = await db.$queryRaw<{ id: bigint; consumer: string; event_id: bigint; event_type: string; aggregate_type: string; aggregate_id: string; payload: unknown }[]>`
    SELECT d.id, d.consumer, e.id AS event_id, e.event_type, e.aggregate_type, e.aggregate_id, e.payload
      FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id WHERE d.id = ${deliveryId}::bigint`;
  return r ? { deliveryId: Number(r.id), consumer: r.consumer, eventId: Number(r.event_id), eventType: r.event_type, aggregateType: r.aggregate_type, aggregateId: r.aggregate_id, payload: r.payload } : null;
}

/**
 * DB-only consumers: begin → effect → complete in ONE transaction, so the effect happens exactly once in the database
 * however many times the job is delivered. Returns false when the delivery was already done.
 */
export async function consumeInTransaction(prisma: PrismaClient, deliveryId: number, effect: (tx: Prisma.TransactionClient, ev: OutboxEventRow) => Promise<void>): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    if (!(await fn.outboxBeginConsume(tx, deliveryId))) return false;
    const ev = await loadDelivery(tx, deliveryId);
    if (!ev) return false;
    await effect(tx, ev);
    await fn.outboxComplete(tx, deliveryId);
    return true;
  }, { maxWait: 10_000, timeout: 60_000 });
}
