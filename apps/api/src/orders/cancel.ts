// Cancellation (task 5.3; product.md §8.6, database.md §4.2 and §8.3a). Placed / confirmed orders go through
// aq_cancel_order (refund for prepaid, COD not collected, stock, sold counts and coupon restored, email) in the
// idempotent request's transaction; unpaid orders through aq_release_unpaid_order. Customers may cancel until the
// order is packed, staff until it ships. Endpoints: POST /admin/orders/:id/cancel (orders:cancel) and
// POST /me/orders/:orderNumber/cancel (the signed-in owner). The guest route needs the order access cookie (task 5.7).
import { adminCancelOrderBody, customerCancelOrderBody, type Permission } from '@artq/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';
import { recordAudit } from '../admin/router.js';
import { requireCustomer, type AuthDeps } from '../auth/middleware.js';
import { DbFunctionError } from '../db/errors.js';
import * as fn from '../db/functions.js';
import { idempotent, type IdempotencyContext } from '../idempotency/idempotency.js';
import { AppError } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { AdminOrderService, describe } from './admin-service.js';

type Who = { by: 'CUSTOMER' | 'ADMIN'; actorId: number | null; audit?: (tx: Prisma.TransactionClient, e: { before: unknown; after: unknown }) => Promise<void> };
export type CancelResult = { orderNumber: string; status: 'CANCELLED'; refund: { id: number; amount: number } | null; paymentStatus: string };

/** Cancels inside the idempotent request (every write in ctx.tx, fenced by the key's owner token). */
export async function cancelOrder(prisma: PrismaClient, ctx: IdempotencyContext, orderId: number, who: Who, reason: string | null, notify: boolean): Promise<CancelResult> {
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { orderNumber: true, status: true, paymentStatus: true, fulfilmentStatus: true } });
  if (!o) throw new AppError(404, 'NOT_FOUND', 'Order not found');
  try {
    return await ctx.tx(async (tx) => {
      let out: CancelResult;
      if (o.status === 'PENDING_PAYMENT') {
        const r = await fn.releaseUnpaidOrder(tx, { orderId, newStatus: 'CANCELLED', reason: reason ?? 'Cancelled before payment', actor: who.by });
        if (r === 'SKIPPED') throw new AppError(409, 'PAYMENT_IN_PROGRESS', 'A payment for this order is being confirmed. Try again in a few minutes.');
        out = { orderNumber: o.orderNumber, status: 'CANCELLED', refund: null, paymentStatus: o.paymentStatus };
      } else {
        const r = await fn.cancelOrder(tx, { orderId, by: who.by, actorId: who.actorId, reason, notify });
        const refund = r.refund_id ? await tx.refund.findUniqueOrThrow({ where: { id: r.refund_id }, select: { id: true, amount: true } }) : null;
        out = { orderNumber: o.orderNumber, status: 'CANCELLED', refund, paymentStatus: r.payment_status };
      }
      await ctx.attach(tx, 'order', o.orderNumber);
      await who.audit?.(tx, { before: o, after: { ...out, reason, notifyCustomer: notify } });
      return out;
    });
  } catch (e) {
    if (e instanceof DbFunctionError && e.code === 'INVALID_TRANSITION') {
      const now = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, paymentStatus: true, fulfilmentStatus: true } });
      const why = who.by === 'CUSTOMER' && ['PLACED', 'CONFIRMED'].includes(now.status) && now.fulfilmentStatus !== 'UNFULFILLED'
        ? 'Your order is already being packed, so it can’t be cancelled online. Contact us and we’ll help.'
        : `This order can’t be cancelled now: it is ${describe(now)}.`;
      throw new AppError(422, 'INVALID_TRANSITION', why, { current: now });
    }
    throw e;
  }
}

type AdminRoutes = { routes: Router; can: (p: Permission) => RequestHandler };
const idParam = z.strictObject({ id: z.coerce.number().int().positive().max(2_147_483_647) });

export function registerCancelRoutes(admin: AdminRoutes, prisma: PrismaClient, log: Logger, details = new AdminOrderService(prisma)): void {
  const id = (req: Request) => (req.params as unknown as { id: number }).id;
  admin.routes.post('/orders/:id/cancel', admin.can('orders:cancel'), validate({ params: idParam, body: adminCancelOrderBody }), idempotent({ prisma, log }, {
    operation: 'order.cancel', scope: (req) => `staff:${req.auth!.userId}`, target: (req) => `order:${id(req)}`,
  }, async (req, ctx) => {
    const b = req.body as z.output<typeof adminCancelOrderBody>;
    const res = req.res as Response;
    await cancelOrder(prisma, ctx, id(req), { by: 'ADMIN', actorId: req.auth!.userId, audit: (tx, e) => recordAudit(tx, req, res, { action: 'order.cancel', entity: 'order', entityId: id(req), ...e }) }, b.reason, b.notifyCustomer);
    return { status: 200, body: await details.detail(id(req), true), resource: { type: 'order', id: String(id(req)) } };
  }));
}

const orderParam = z.strictObject({ orderNumber: z.string().regex(/^[A-Za-z0-9-]{3,20}$/) });

export function customerOrderRouter(d: AuthDeps & { prisma: PrismaClient; log: Logger }): Router {
  const r = Router();
  const auth = requireCustomer(d);
  const num = (req: Request) => (req.params as { orderNumber: string }).orderNumber;
  r.post('/me/orders/:orderNumber/cancel', auth, validate({ params: orderParam, body: customerCancelOrderBody }), idempotent({ prisma: d.prisma, log: d.log }, {
    operation: 'order.cancel', scope: (req) => `user:${req.auth!.userId}`, target: (req) => `order:${num(req)}`,
  }, async (req, ctx) => {
    const o = await d.prisma.order.findFirst({ where: { orderNumber: num(req), userId: req.auth!.userId }, select: { id: true } });
    if (!o) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    const out = await cancelOrder(d.prisma, ctx, o.id, { by: 'CUSTOMER', actorId: req.auth!.userId }, (req.body as z.output<typeof customerCancelOrderBody>).reason, true);
    return { status: 200, body: out, resource: { type: 'order', id: out.orderNumber } };
  }));
  return r;
}
