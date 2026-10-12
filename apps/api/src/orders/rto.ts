// RTO received and lost parcels (task 5.6; architecture.md §10.1, database.md §8.4a) [orders:fulfil]. Both are one
// database function under the order lock (aq_receive_rto, aq_mark_lost): stock, cancellation, refund and coupon happen
// together or not at all, and a second press finds the order moved on (INVALID_TRANSITION). This module explains
// refusals on the field they belong to and audits the change in the same transaction.
import type { lostOrderBody, rtoReceivedBody } from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import type { z } from 'zod';
import { DbFunctionError } from '../db/errors.js';
import * as fn from '../db/functions.js';
import { AppError } from '../lib/errors.js';
import { describe, type Actor } from './admin-service.js';

async function refused(prisma: PrismaClient, id: number, e: unknown, verb: string, items: { orderItemId: number }[] = []): Promise<never> {
  if (e instanceof DbFunctionError && e.code === 'INVALID_TRANSITION') {
    const now = await prisma.order.findUniqueOrThrow({ where: { id }, select: { status: true, paymentStatus: true, fulfilmentStatus: true } });
    throw new AppError(422, 'INVALID_TRANSITION', `This order can’t be ${verb} now: it is ${describe(now)}. Reload to see its latest state.`, { current: now });
  }
  if (e instanceof DbFunctionError && e.code === 'RTO_INSPECTION_INVALID') {
    const n = items.findIndex((i) => i.orderItemId === Number(e.detail));
    if (n >= 0) throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: `items.${n}.sellableQty`, message: 'Sellable and damaged units must add up to the units in the order' }]);
    throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'items', message: 'Inspect every item of the order, each once' }]);
  }
  throw e;
}

async function exists(prisma: PrismaClient, id: number) {
  const o = await prisma.order.findUnique({ where: { id }, select: { status: true, paymentStatus: true, fulfilmentStatus: true } });
  if (!o) throw new AppError(404, 'NOT_FOUND', 'Order not found');
  return o;
}

/** RTO_IN_TRANSIT → RTO_RECEIVED: restock sellable units, cancel the order, refund prepaid items (not shipping, D-9). */
export async function receiveRto(prisma: PrismaClient, id: number, b: z.output<typeof rtoReceivedBody>, actor: Actor): Promise<void> {
  const before = await exists(prisma, id);
  try {
    await prisma.$transaction(async (tx) => {
      const r = await fn.receiveRto(tx, { orderId: id, items: b.items, notify: b.notifyCustomer, actorId: actor.userId });
      await actor.audit(tx, { action: 'order.rto_received', entity: 'order', entityId: id, before, after: { ...b, refundId: r.refund_id } });
    });
  } catch (e) { await refused(prisma, id, e, 'received back', b.items); }
}

/** SHIPPED / OUT_FOR_DELIVERY / RTO_IN_TRANSIT → LOST: refund (cancel with a full refund) or reship (keep the order). */
export async function markLost(prisma: PrismaClient, id: number, b: z.output<typeof lostOrderBody>, actor: Actor): Promise<void> {
  const before = await exists(prisma, id);
  try {
    await prisma.$transaction(async (tx) => {
      const r = await fn.markLost(tx, { orderId: id, resolution: b.resolution, note: b.note, notify: b.notifyCustomer, actorId: actor.userId });
      await actor.audit(tx, { action: 'order.lost', entity: 'order', entityId: id, before, after: { ...b, refundId: r.refund_id } });
    });
  } catch (e) { await refused(prisma, id, e, 'marked lost'); }
}
