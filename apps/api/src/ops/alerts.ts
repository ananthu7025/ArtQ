// Operational alerts (architecture.md §13, task 5.8). One set of checks, used by the Jobs & Webhooks summary and by the
// `ops-alerts` job (every 5 minutes), which emails staff (`email.admin`, template admin_ops_alert) at most once an hour
// per alert. Checks that need the platform (API 5xx rate, readiness, certificates, backups) belong to the uptime
// monitor and Sentry, not here.
import type { OpsAlert } from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import * as fn from '../db/functions.js';

/** Money exceptions that page someone when open for an hour (§13). */
export const URGENT_EXCEPTIONS = ['EXCESS_CAPTURE', 'LATE_CAPTURE_EXPIRED', 'LATE_CAPTURE_CANCELLED', 'AMOUNT_MISMATCH', 'REFUND_FAILED'] as const;

type Count = { n: number };
/** A count from a fixed query (constant SQL written here, never user input). */
const one = async (prisma: PrismaClient, sql: string) => ((await prisma.$queryRawUnsafe<Count[]>(sql))[0]?.n ?? 0);

/** BullMQ failed-job counts, when the caller can read them (the worker can; tests pass them in). */
export type FailedJobs = { recentFailed: number } | null;

export async function evaluateAlerts(prisma: PrismaClient, failed: FailedJobs = null): Promise<OpsAlert[]> {
  const out: OpsAlert[] = [];
  const add = (n: number, a: Omit<OpsAlert, 'detail'> & { detail: (n: number) => string }) => { if (n > 0) out.push({ key: a.key, severity: a.severity, title: a.title, detail: a.detail(n) }); };

  add(await one(prisma, `SELECT count(*)::int AS n FROM webhook_events WHERE status IN ('FAILED','DEAD') AND received_at < now() - interval '15 minutes'`), {
    key: 'webhooks-failing', severity: 'P1', title: 'Razorpay notifications are failing', detail: (n) => `${n} notification(s) failed or gave up for more than 15 minutes.` });
  add(await one(prisma, `SELECT count(*)::int AS n FROM payment_exceptions WHERE status IN ('OPEN','AUTO_RESOLVING') AND type::text = ANY(ARRAY['${URGENT_EXCEPTIONS.join("','")}']) AND created_at < now() - interval '1 hour'`), {
    key: 'money-exceptions', severity: 'P1', title: 'Money exceptions waiting over an hour', detail: (n) => `${n} payment exception(s) (double payments, late payments, amount mismatches, failed refunds) open for more than an hour.` });
  add(await one(prisma, `SELECT count(*)::int AS n FROM refunds WHERE status = 'UNKNOWN' AND updated_at < now() - interval '30 minutes'`), {
    key: 'refunds-unknown', severity: 'P1', title: 'Refunds with an unknown outcome', detail: (n) => `${n} refund(s) still unknown after 30 minutes.` });
  add(await one(prisma, `SELECT count(*)::int AS n FROM payment_exceptions WHERE type = 'REFUND_IDEMPOTENCY_MISMATCH' AND status IN ('OPEN','AUTO_RESOLVING')`), {
    key: 'refund-mismatch', severity: 'P1', title: 'A refund conflicts at Razorpay', detail: (n) => `${n} refund(s) with an idempotency mismatch. Check them in Razorpay before anything else.` });
  add(await one(prisma, `SELECT count(*)::int AS n FROM payment_exceptions WHERE type = 'RECON_MISMATCH' AND status IN ('OPEN','AUTO_RESOLVING') AND created_at < now() - interval '1 hour'`), {
    key: 'refund-gate', severity: 'P1', title: 'Razorpay refunds not reconciled', detail: (n) => `${n} payment(s) with refunds made outside ArtQ still unexplained after an hour; new refunds on them are blocked.` });
  add(await one(prisma, `SELECT count(*)::int AS n FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id
      WHERE d.status = 'DEAD' OR (d.status IN ('PENDING','LEASED') AND e.created_at < now() - interval '5 minutes' AND d.next_attempt_at < now() - interval '5 minutes')
         OR (d.status = 'PUBLISHED' AND d.published_at < now() - interval '30 minutes')`), {
    key: 'outbox-stuck', severity: 'P2', title: 'Background tasks are stuck', detail: (n) => `${n} background task(s) dead or not finished in time (emails, refunds, invoices). See Jobs & Webhooks.` });
  add(await one(prisma, `SELECT count(*)::int AS n FROM orders WHERE status = 'PENDING_PAYMENT' AND payment_status = 'PROCESSING' AND updated_at < now() - interval '30 minutes'`), {
    key: 'payments-processing', severity: 'P2', title: 'Payments stuck in processing', detail: (n) => `${n} order(s) in "payment processing" for more than 30 minutes.` });
  add(await one(prisma, `SELECT count(*)::int AS n FROM payment_attempts WHERE status = 'PROVIDER_UNKNOWN' AND updated_at < now() - interval '10 minutes'`), {
    key: 'attempts-unknown', severity: 'P2', title: 'Payment attempts in an unknown state', detail: (n) => `${n} payment attempt(s) unknown to Razorpay for more than 10 minutes.` });
  add(await one(prisma, `SELECT count(*)::int AS n FROM payment_exceptions WHERE type = 'OVERSOLD' AND status IN ('OPEN','AUTO_RESOLVING')`), {
    key: 'oversold', severity: 'P2', title: 'Stock oversold', detail: (n) => `${n} variant(s) have more reserved than in stock. Recount or cancel an order.` });
  if (failed && failed.recentFailed > 10) out.push({ key: 'jobs-failing', severity: 'P2', title: 'Background jobs are failing', detail: `${failed.recentFailed} jobs failed in the last 10 minutes.` });
  add(await one(prisma, `SELECT count(*)::int AS n FROM search_reindex_queue WHERE enqueued_at < now() - interval '5 minutes'`), {
    key: 'search-behind', severity: 'P3', title: 'Search is behind', detail: (n) => `${n} product(s) waiting more than 5 minutes for search to update.` });
  add(await one(prisma, `SELECT count(*)::int AS n FROM payment_exceptions WHERE type = 'PUBLISHED_NOT_READY' AND status IN ('OPEN','AUTO_RESOLVING')`), {
    key: 'published-not-ready', severity: 'P3', title: 'Live products missing something', detail: (n) => `${n} live product(s) fail their readiness check.` });
  return out;
}

/** The ops-alerts job: one staff email per alert per hour (the outbox event key is the alert and the hour). */
export async function notifyAlerts(prisma: PrismaClient, failed: FailedJobs = null, now = new Date()): Promise<{ alerts: number; notified: number }> {
  const alerts = await evaluateAlerts(prisma, failed);
  const hour = now.toISOString().slice(0, 13);
  let notified = 0;
  for (const a of alerts) {
    const id = `${a.key}@${hour}`.slice(0, 40);
    const sent = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const seen = await tx.$queryRaw<Count[]>`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'ops.alert' AND aggregate_id = ${id}`;
      if (seen[0]!.n > 0) return false;
      await fn.emit(tx, { aggregateType: 'ops', aggregateId: id, type: 'ops.alert', payload: a, consumers: ['email.admin'] });
      return true;
    });
    if (sent) notified++;
  }
  return { alerts: alerts.length, notified };
}
