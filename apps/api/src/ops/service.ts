// Payment Exceptions and Jobs & Webhooks (task 5.8; api.md §4.10, product.md §7.5, architecture.md §13, §15).
// Exceptions: the queue, resolve / dismiss with a note (the order's exception badge follows), a manual reconcile.
// Ops: queue depths and failed jobs (BullMQ), the webhook inbox, outbox deliveries by consumer, the search queue, the
// last scheduled runs, the alerts; retry a dead webhook, a dead delivery or a failed job. Retries only put work back
// in line: the same fenced, idempotent consumers process it, so a retry never does anything twice.
import type { AdminExceptionRow, exceptionListQuery, OpsFailedJob, OpsOutboxRow, OpsSummary, OpsWebhookRow, opsOutboxQuery, opsWebhookQuery } from '@artq/shared';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import type { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { OUTBOX_CONSUMERS } from '../outbox/dispatcher.js';
import { applySnapshot } from '../payments/apply.js';
import type { PaymentProvider } from '../payments/razorpay.js';
import { reconcileRefunds } from '../payments/refunds.js';
import { evaluateAlerts } from './alerts.js';

type Tx = Prisma.TransactionClient;
const OPEN = ['OPEN', 'AUTO_RESOLVING'] as const;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const page = (q: { page: number; limit: number }, total: number) => ({ page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) });
/** Scheduled maintenance jobs whose last run the worker records (Redis `ops:last:<name>`). */
export const SCHEDULED = ['payments-reconcile', 'orders-expire', 'refunds-reconcile', 'payments-daily', 'webhook-sweep', 'retention', 'catalog-check', 'cod-overdue', 'ops-alerts'] as const;
export const lastRunKey = (name: string) => `ops:last:${name}`;

export type OpsDeps = {
  prisma: PrismaClient;
  /** Queues by name (BullMQ); null when Redis is not available to the API. */
  queues: ReadonlyMap<string, Pick<Queue, 'name' | 'getJobCounts' | 'getFailed' | 'getJob'>> | null;
  /** Reads the last-run records; null → unknown. */
  readLastRuns: (names: readonly string[]) => Promise<(string | null)[]>;
  /** Puts a webhook back on its queue now (the minute sweeper would too). */
  enqueueWebhook?: (id: number) => Promise<void>;
  /** Razorpay, for a manual reconcile; null without keys. */
  provider: PaymentProvider | null;
};

export class OpsService {
  constructor(private readonly d: OpsDeps) {}
  /** The database (routes audit with it). */
  get prisma() { return this.d.prisma; }

  // ── Payment exceptions ──
  async exceptions(q: z.output<typeof exceptionListQuery>) {
    const where: Prisma.PaymentExceptionWhereInput = {
      ...(q.status ? { status: q.status } : q.open ? { status: { in: [...OPEN] } } : {}),
      ...(q.type ? { type: q.type } : {}), ...(q.orderId ? { orderId: q.orderId } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.paymentException.count({ where }),
      this.prisma.paymentException.findMany({ where, include: { order: { select: { id: true, orderNumber: true } }, payment: { select: { providerPaymentId: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    const staff = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.resolvedBy).filter((x): x is number => x !== null))] } }, select: { id: true, name: true, email: true } });
    const now = Date.now();
    const data: AdminExceptionRow[] = rows.map((r) => {
      const who = staff.find((u) => u.id === r.resolvedBy);
      return {
        id: r.id, type: r.type, status: r.status, createdAt: r.createdAt.toISOString(), ageMinutes: Math.floor((now - r.createdAt.getTime()) / 60_000), amount: r.amount,
        order: r.order, refundId: r.refundId, paymentId: r.payment?.providerPaymentId ?? null, details: (r.details ?? {}) as Record<string, unknown>,
        resolution: r.resolution, resolvedAt: iso(r.resolvedAt), resolvedBy: who ? (who.name ?? who.email) : null,
      };
    });
    return { data, meta: page(q, total) };
  }

  /** OPEN / AUTO_RESOLVING → RESOLVED or DISMISSED once (a second press → 422); the order's badge is recomputed. */
  async close(id: number, to: 'RESOLVED' | 'DISMISSED', text: string, actorId: number, audit: (tx: Tx, before: unknown) => Promise<void>): Promise<AdminExceptionRow> {
    const ex = await this.prisma.paymentException.findUnique({ where: { id }, select: { orderId: true, status: true } });
    if (!ex) throw new AppError(404, 'NOT_FOUND', 'Exception not found');
    await this.prisma.$transaction(async (tx) => {
      if (ex.orderId) await tx.$executeRaw`SELECT 1 FROM orders WHERE id = ${ex.orderId} FOR NO KEY UPDATE`;
      const n = await tx.paymentException.updateMany({ where: { id, status: { in: [...OPEN] } }, data: { status: to, resolution: text, resolvedAt: new Date(), resolvedBy: actorId } });
      if (n.count !== 1) throw new AppError(422, 'INVALID_TRANSITION', 'Someone has already closed this exception. Reload to see the latest.');
      if (ex.orderId) await syncOrderBadge(tx, ex.orderId);
      await audit(tx, { status: ex.status });
    });
    return this.one(id);
  }

  private async one(id: number): Promise<AdminExceptionRow> {
    const r = await this.prisma.paymentException.findUniqueOrThrow({ where: { id }, include: { order: { select: { id: true, orderNumber: true } }, payment: { select: { providerPaymentId: true } } } });
    const who = r.resolvedBy ? await this.prisma.user.findUnique({ where: { id: r.resolvedBy }, select: { name: true, email: true } }) : null;
    return { id: r.id, type: r.type, status: r.status, createdAt: r.createdAt.toISOString(), ageMinutes: Math.floor((Date.now() - r.createdAt.getTime()) / 60_000), amount: r.amount,
      order: r.order, refundId: r.refundId, paymentId: r.payment?.providerPaymentId ?? null, details: (r.details ?? {}) as Record<string, unknown>,
      resolution: r.resolution, resolvedAt: iso(r.resolvedAt), resolvedBy: who ? (who.name ?? who.email) : null };
  }

  /** Re-reads Razorpay now: one order's payment orders, or the regular sweep of open refunds. */
  async reconcile(orderId: number | undefined, log: { warn: (o: object, m: string) => void }) {
    if (!this.d.provider) throw new AppError(422, 'PAYMENT_METHOD_UNAVAILABLE', 'Razorpay isn’t connected (no API keys), so there is nothing to reconcile with.');
    const provider = this.d.provider;
    let applied = 0;
    if (orderId) {
      const o = await this.prisma.order.findUnique({ where: { id: orderId }, include: { paymentAttempts: { where: { providerOrderId: { not: null } }, select: { providerOrderId: true } } } });
      if (!o) throw new AppError(404, 'NOT_FOUND', 'Order not found');
      if (o.paymentMethod !== 'RAZORPAY') throw new AppError(422, 'INVALID_TRANSITION', 'This order was not paid online, so there is nothing at Razorpay to reconcile.');
      for (const a of o.paymentAttempts) {
        for (const p of await provider.orderPayments(a.providerOrderId!)) {
          if (!['authorized', 'captured', 'refunded'].includes(p.status)) continue;
          await applySnapshot(this.prisma, p, 'SYSTEM');
          applied++;
        }
      }
    }
    const refunds = await reconcileRefunds({ prisma: this.prisma, provider, log: log as never });
    return { applied, refunds };
  }

  // ── Jobs & webhooks ──
  async summary(): Promise<OpsSummary> {
    const queues = this.d.queues ? await Promise.all([...this.d.queues.values()].map(async (q) => {
      try { const c = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'); return { name: q.name, waiting: c.waiting ?? 0, active: c.active ?? 0, delayed: c.delayed ?? 0, failed: c.failed ?? 0, completed: c.completed ?? 0 }; }
      catch { return null; }
    })) : null;
    const counts = queues?.every((q) => q !== null) ? (queues as NonNullable<(typeof queues)[number]>[]) : null;
    const recentFailed = this.d.queues ? await this.recentFailed() : null;
    const [webhooks, outbox, search, exc, lastRuns, alerts] = await Promise.all([
      this.prisma.$queryRaw<{ status: string; n: number }[]>`SELECT status::text, count(*)::int AS n FROM webhook_events GROUP BY status`,
      this.prisma.$queryRaw<{ consumer: string; pending: number; leased: number; published: number; stuck: number; dead: number }[]>`
        SELECT d.consumer,
               count(*) FILTER (WHERE d.status = 'PENDING')::int AS pending, count(*) FILTER (WHERE d.status = 'LEASED')::int AS leased,
               count(*) FILTER (WHERE d.status = 'PUBLISHED')::int AS published, count(*) FILTER (WHERE d.status = 'DEAD')::int AS dead,
               count(*) FILTER (WHERE (d.status IN ('PENDING','LEASED') AND d.next_attempt_at < now() - interval '5 minutes')
                                   OR (d.status = 'PUBLISHED' AND d.published_at < now() - interval '30 minutes'))::int AS stuck
          FROM outbox_deliveries d WHERE d.status <> 'COMPLETED' GROUP BY d.consumer ORDER BY d.consumer`,
      this.prisma.$queryRaw<{ depth: number; oldest: number | null }[]>`SELECT count(*)::int AS depth, floor(extract(epoch FROM now() - min(enqueued_at)) / 60)::int AS oldest FROM search_reindex_queue`,
      this.prisma.$queryRaw<{ open: number; oldest: number | null }[]>`SELECT count(*)::int AS open, floor(extract(epoch FROM now() - min(created_at)) / 60)::int AS oldest FROM payment_exceptions WHERE status IN ('OPEN','AUTO_RESOLVING')`,
      this.d.readLastRuns(SCHEDULED).catch(() => SCHEDULED.map(() => null)),
      evaluateAlerts(this.prisma, recentFailed === null ? null : { recentFailed }),
    ]);
    return {
      alerts, queues: counts,
      webhooks: Object.fromEntries(webhooks.map((w) => [w.status, w.n])),
      outbox: outbox,
      searchQueue: { depth: search[0]!.depth, oldestMinutes: search[0]!.oldest },
      exceptions: { open: exc[0]!.open, oldestMinutes: exc[0]!.oldest },
      schedulers: SCHEDULED.map((name, i) => {
        const raw = lastRuns[i];
        const r = raw ? (JSON.parse(raw) as { at: string; ok: boolean; result: string }) : null;
        return { name, lastRunAt: r?.at ?? null, ok: r?.ok ?? null, result: r?.result ?? null };
      }),
    };
  }

  private recentFailed(): Promise<number> { return countRecentFailed(this.d.queues!.values()); }

  async webhooks(q: z.output<typeof opsWebhookQuery>) {
    const where: Prisma.WebhookEventWhereInput = q.status ? { status: q.status } : {};
    const [total, rows] = await Promise.all([
      this.prisma.webhookEvent.count({ where }),
      this.prisma.webhookEvent.findMany({ where, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit, select: { id: true, provider: true, eventId: true, eventType: true, status: true, attempts: true, lastError: true, receivedAt: true, nextAttemptAt: true, processedAt: true } }),
    ]);
    const data: OpsWebhookRow[] = rows.map((r) => ({ ...r, lastError: r.lastError?.slice(0, 500) ?? null, receivedAt: r.receivedAt.toISOString(), nextAttemptAt: r.nextAttemptAt.toISOString(), processedAt: iso(r.processedAt) }));
    return { data, meta: page(q, total) };
  }

  /** FAILED / DEAD → RECEIVED, due now, attempts from zero; enqueued at once. */
  async retryWebhook(id: number, audit: (tx: Tx) => Promise<void>) {
    await this.prisma.$transaction(async (tx) => {
      const n = await tx.$executeRaw`UPDATE webhook_events SET status = 'RECEIVED', attempts = 0, next_attempt_at = now(), last_error = NULL, lease_token = NULL, locked_until = NULL
                                      WHERE id = ${id} AND status IN ('FAILED', 'DEAD')`;
      if (n !== 1) {
        if (!(await tx.webhookEvent.findUnique({ where: { id }, select: { id: true } }))) throw new AppError(404, 'NOT_FOUND', 'Webhook not found');
        throw new AppError(422, 'INVALID_TRANSITION', 'Only a failed or dead notification can be retried.');
      }
      await audit(tx);
    });
    await this.d.enqueueWebhook?.(id).catch(() => { /* the minute sweeper picks it up */ });
  }

  async outbox(q: z.output<typeof opsOutboxQuery>) {
    const status = q.status === 'STUCK'
      ? Prisma.sql`((d.status IN ('PENDING','LEASED') AND d.next_attempt_at < now() - interval '5 minutes') OR (d.status = 'PUBLISHED' AND d.published_at < now() - interval '30 minutes'))`
      : q.status ? Prisma.sql`d.status = ${q.status}::"OutboxStatus"` : Prisma.sql`d.status <> 'COMPLETED'`;
    const consumer = q.consumer ? Prisma.sql`AND d.consumer = ${q.consumer}` : Prisma.empty;
    const [{ n }] = await this.prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox_deliveries d WHERE ${status} ${consumer}` as [{ n: number }];
    const rows = await this.prisma.$queryRaw<{ id: bigint; consumer: string; event_type: string; aggregate: string; status: string; generation: number; last_error: string | null; created_at: Date; published_at: Date | null; next_attempt_at: Date }[]>`
      SELECT d.id, d.consumer, e.event_type, e.aggregate_type || ' ' || e.aggregate_id AS aggregate, d.status::text, d.generation, d.last_error, e.created_at, d.published_at, d.next_attempt_at
        FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id WHERE ${status} ${consumer}
       ORDER BY d.id DESC OFFSET ${(q.page - 1) * q.limit}::int LIMIT ${q.limit}::int`;
    const data: OpsOutboxRow[] = rows.map((r) => ({ id: Number(r.id), consumer: r.consumer, eventType: r.event_type, aggregate: r.aggregate, status: r.status, generation: r.generation, lastError: r.last_error?.slice(0, 500) ?? null,
      createdAt: r.created_at.toISOString(), publishedAt: iso(r.published_at), nextAttemptAt: r.next_attempt_at.toISOString() }));
    return { data, meta: page(q, n), consumers: Object.keys(OUTBOX_CONSUMERS) };
  }

  /** DEAD → PENDING with the generation reset (the dispatcher publishes it again; the consumer's dedupe still holds). */
  async retryOutbox(id: number, audit: (tx: Tx) => Promise<void>) {
    await this.prisma.$transaction(async (tx) => {
      const n = await tx.$executeRaw`UPDATE outbox_deliveries SET status = 'PENDING', generation = 0, next_attempt_at = now(), last_error = NULL, lease_token = NULL, lease_expires_at = NULL
                                      WHERE id = ${id}::bigint AND status = 'DEAD'`;
      if (n !== 1) {
        if ((await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox_deliveries WHERE id = ${id}::bigint`)[0]!.n === 0) throw new AppError(404, 'NOT_FOUND', 'Delivery not found');
        throw new AppError(422, 'INVALID_TRANSITION', 'Only a dead delivery can be retried; the others are still being worked on.');
      }
      await audit(tx);
    });
  }

  async failedJobs(): Promise<OpsFailedJob[]> {
    if (!this.d.queues) throw new AppError(503, 'UNAVAILABLE', 'The job queues can’t be read right now (Redis unavailable).');
    const out: OpsFailedJob[] = [];
    for (const q of this.d.queues.values()) {
      for (const j of await q.getFailed(0, 49)) out.push({ queue: q.name, id: String(j.id), name: j.name, failedReason: j.failedReason?.slice(0, 500) ?? null, attemptsMade: j.attemptsMade, failedAt: j.finishedOn ? new Date(j.finishedOn).toISOString() : null });
    }
    return out.sort((a, b) => (b.failedAt ?? '').localeCompare(a.failedAt ?? '')).slice(0, 200);
  }

  async retryJob(queue: string, id: string) {
    const q = this.d.queues?.get(queue);
    if (!q) throw new AppError(404, 'NOT_FOUND', 'Queue not found');
    const job = await q.getJob(id);
    if (!job) throw new AppError(404, 'NOT_FOUND', 'Job not found');
    if (!(await job.isFailed())) throw new AppError(422, 'INVALID_TRANSITION', 'Only a failed job can be retried.');
    await job.retry('failed');
  }
}

/** Jobs that failed in the last 10 minutes across these queues (alert: more than 10). */
export async function countRecentFailed(queues: Iterable<Pick<Queue, 'getFailed'>>, now = Date.now()): Promise<number> {
  let n = 0;
  for (const q of queues) {
    try { n += (await q.getFailed(0, 99)).filter((j) => (j.finishedOn ?? 0) >= now - 10 * 60_000).length; } catch { /* a queue that can't be read counts as none */ }
  }
  return n;
}

/** The order's exception badge = it has an exception that still needs someone. */
export async function syncOrderBadge(db: Tx | PrismaClient, orderId: number) {
  await db.$executeRaw`UPDATE orders SET has_open_exception = EXISTS (SELECT 1 FROM payment_exceptions WHERE order_id = ${orderId} AND status IN ('OPEN','AUTO_RESOLVING')) WHERE id = ${orderId}`;
}

/** Badges whose exceptions were resolved automatically (e.g. a refund processed) are cleared by the ops-alerts job. */
export async function syncAllBadges(prisma: PrismaClient): Promise<number> {
  return prisma.$executeRaw`UPDATE orders o SET has_open_exception = false WHERE o.has_open_exception
     AND NOT EXISTS (SELECT 1 FROM payment_exceptions x WHERE x.order_id = o.id AND x.status IN ('OPEN','AUTO_RESOLVING'))`;
}
