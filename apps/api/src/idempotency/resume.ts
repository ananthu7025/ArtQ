// Resume-on-takeover (api.md §1.2, database.md §8.1): when a retry takes over an expired key whose previous owner had
// attached a resource, the new owner continues THAT resource and never creates a second one. These loaders return what
// each operation needs to continue; the decisions (adopt the provider order by receipt, resend the same refund attempt)
// belong to the checkout and refund services (Phases 4–5).
import type { PaymentAttempt, Prisma, PrismaClient, Refund, RefundAttempt } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export type Resumed =
  | { kind: 'order'; orderId: number; orderNumber: string; status: string; paymentStatus: string; openAttempt: PaymentAttempt | null }
  | { kind: 'payment_attempt'; attempt: PaymentAttempt }
  | { kind: 'refund'; refund: Refund; latestAttempt: RefundAttempt | null };

export class ResumeTargetMissingError extends Error {
  constructor(type: string, id: string) { super(`resume target ${type} ${id} no longer exists`); this.name = 'ResumeTargetMissingError'; }
}

const OPEN_ATTEMPT = ['CREATING', 'CREATED', 'PROVIDER_UNKNOWN'] as const;   // attempts_one_open_per_order_uq

export async function loadResume(db: Db, resume: { resourceType: string; resourceId: string }): Promise<Resumed> {
  const { resourceType: type, resourceId: id } = resume;
  switch (type) {
    case 'order': {
      const o = await db.order.findUnique({ where: { orderNumber: id }, select: { id: true, orderNumber: true, status: true, paymentStatus: true } });
      if (!o) throw new ResumeTargetMissingError(type, id);
      const openAttempt = await db.paymentAttempt.findFirst({ where: { orderId: o.id, status: { in: [...OPEN_ATTEMPT] } } });
      return { kind: 'order', orderId: o.id, orderNumber: o.orderNumber, status: o.status, paymentStatus: o.paymentStatus, openAttempt };
    }
    case 'payment_attempt': {
      if (!/^\d+$/.test(id)) throw new ResumeTargetMissingError(type, id);
      const attempt = await db.paymentAttempt.findUnique({ where: { id: Number(id) } });
      if (!attempt) throw new ResumeTargetMissingError(type, id);
      return { kind: 'payment_attempt', attempt };
    }
    case 'refund': {
      if (!/^\d+$/.test(id)) throw new ResumeTargetMissingError(type, id);
      const refund = await db.refund.findUnique({ where: { id: Number(id) } });
      if (!refund) throw new ResumeTargetMissingError(type, id);
      // The current attempt keeps its provider idempotency key and request body: resending it is safe.
      const latestAttempt = await db.refundAttempt.findFirst({ where: { refundId: refund.id, attemptNo: refund.attemptNo } });
      return { kind: 'refund', refund, latestAttempt };
    }
    default:
      throw new TypeError(`no resume loader for resource type "${type}"`);
  }
}
