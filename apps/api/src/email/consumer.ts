// Email consumers `email.customer` and `email.admin` (architecture.md §8.3):
//   TX  aq_outbox_begin_consume → email_logs row per recipient (SENDING, dedupe_key; skip if SENT)
//   NET provider call per recipient with an idempotency key derived from that email_logs row
//   TX  mark SENT (per recipient, as each succeeds)
//   TX  aq_outbox_complete (+ scrub OTP codes / links from the event payload)
// At-least-once: a crash after the provider accepted but before SENT is recorded resends with the SAME idempotency key,
// which Resend deduplicates; SMTP (local) cannot. Exactly-once email is not promised.
import { createHash } from 'node:crypto';
import { parseSetting } from '@artq/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import * as fn from '../db/functions.js';
import { loadDelivery, type OutboxEventRow } from '../outbox/consume.js';
import { render, type Rendered } from './templates.js';
import { EmailSendError, type EmailTransport } from './transport.js';

export type EmailDeps = { prisma: PrismaClient; transport: EmailTransport; from: string; log: Logger };
export type EmailConsumer = 'email.customer' | 'email.admin';
export type EmailResult = { status: 'ALREADY_DONE' | 'SENT' | 'NO_RECIPIENTS'; sent: number; skipped: number };

/** A send for this delivery started less than this long ago and has not finished: let it finish (or time out) first. */
export const IN_FLIGHT_SECONDS = 120;

export class UnsupportedEmailEventError extends Error {
  constructor(consumer: string, eventType: string) { super(`${consumer} has no email for event "${eventType}"`); this.name = 'UnsupportedEmailEventError'; }
}
export class EmailInProgressError extends Error {
  constructor(key: string) { super(`email ${key} is being sent by another worker`); this.name = 'EmailInProgressError'; }
}

type Message = { to: string; template: string; rendered: Rendered; userId: number | null; dedupeKey: string };

const dedupeKey = (deliveryId: number, to: string) => `outbox-${deliveryId}-${createHash('sha256').update(to.toLowerCase()).digest('hex').slice(0, 12)}`;

async function messagesFor(tx: Prisma.TransactionClient, consumer: EmailConsumer, ev: OutboxEventRow): Promise<Message[]> {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  if (consumer === 'email.customer') {
    if (ev.eventType !== 'email.auth') throw new UnsupportedEmailEventError(consumer, ev.eventType);
    const to = String(p.to ?? '');
    const template = String(p.template ?? '');
    if (!to.includes('@')) throw new TypeError(`email.auth event ${ev.eventId} has no recipient`);
    const userId = /^\d+$/.test(ev.aggregateId) && ev.aggregateId !== '0' ? Number(ev.aggregateId) : null;
    return [{ to, template, rendered: render(template, (p.data ?? {}) as Record<string, unknown>), userId, dedupeKey: dedupeKey(ev.deliveryId, to) }];
  }
  if (ev.eventType !== 'payment.exception_raised') throw new UnsupportedEmailEventError(consumer, ev.eventType);
  const setting = await tx.setting.findUnique({ where: { key: 'NOTIFY' } });
  const recipients = setting ? parseSetting('NOTIFY', setting.value).adminEmails : [];
  const rendered = render('admin_payment_exception', p);
  return [...new Set(recipients.map((r) => r.toLowerCase()))].map((to) => ({ to, template: 'admin_payment_exception', rendered, userId: null, dedupeKey: dedupeKey(ev.deliveryId, to) }));
}

export async function processEmailDelivery(d: EmailDeps, consumer: EmailConsumer, deliveryId: number): Promise<EmailResult> {
  // 1. Claim the per-recipient email_logs rows (short transaction).
  const plan = await d.prisma.$transaction(async (tx) => {
    if (!(await fn.outboxBeginConsume(tx, deliveryId))) return null;
    const ev = await loadDelivery(tx, deliveryId);
    if (!ev) return null;
    const messages = await messagesFor(tx, consumer, ev);
    const pending: { m: Message; logId: number; idempotencyKey: string }[] = [];
    let skipped = 0;
    for (const m of messages) {
      const [row] = await tx.$queryRaw<{ id: number; status: string; recent: boolean; created: number }[]>`
        SELECT id, status::text, updated_at > now() - make_interval(secs => ${IN_FLIGHT_SECONDS}::int) AS recent,
               floor(extract(epoch FROM created_at))::int AS created
          FROM email_logs WHERE dedupe_key = ${m.dedupeKey} FOR UPDATE`;
      if (row?.status === 'SENT') { skipped++; continue; }
      if (row?.status === 'SENDING' && row.recent) throw new EmailInProgressError(m.dedupeKey);
      const [log] = row
        ? await tx.$queryRaw<{ id: number; created: number }[]>`
            UPDATE email_logs SET status = 'SENDING', attempts = attempts + 1, error = NULL, updated_at = now()
             WHERE id = ${row.id} RETURNING id, floor(extract(epoch FROM created_at))::int AS created`
        : await tx.$queryRaw<{ id: number; created: number }[]>`
            INSERT INTO email_logs (dedupe_key, outbox_delivery_id, to_email, template, subject, status, attempts, user_id, updated_at)
            VALUES (${m.dedupeKey}, ${deliveryId}::bigint, ${m.to}, ${m.template}, ${m.rendered.subject.slice(0, 200)}, 'SENDING', 1, ${m.userId}::int, now())
            RETURNING id, floor(extract(epoch FROM created_at))::int AS created`;
      // Stable across retries of this row, unique across database resets (provider keys live for 24 h).
      pending.push({ m, logId: log!.id, idempotencyKey: `artq-${m.dedupeKey}-${log!.id}-${log!.created}` });
    }
    return { ev, pending, skipped, total: messages.length };
  }, { maxWait: 10_000, timeout: 30_000 });
  if (!plan) return { status: 'ALREADY_DONE', sent: 0, skipped: 0 };

  // 2. Provider calls, no transaction open.
  let sent = 0;
  for (const { m, logId, idempotencyKey } of plan.pending) {
    try {
      const { messageId } = await d.transport.send({ from: d.from, to: m.to, subject: m.rendered.subject, text: m.rendered.text, html: m.rendered.html, idempotencyKey });
      await d.prisma.$executeRaw`UPDATE email_logs SET status = 'SENT', provider_message_id = ${messageId.slice(0, 120)}, error = NULL, updated_at = now() WHERE id = ${logId}`;
      sent++;
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
      await d.prisma.$executeRaw`UPDATE email_logs SET status = 'FAILED', error = ${msg}, updated_at = now() WHERE id = ${logId}`;
      d.log.warn({ deliveryId, to: m.to.replace(/^(.).*@/, '$1***@'), retryable: e instanceof EmailSendError ? e.retryable : true, err: msg }, 'email send failed');
      throw e;                                                  // BullMQ retries; SENT recipients are skipped next time
    }
  }

  // 3. Complete the delivery and scrub secrets (OTP codes, reset links) once nothing else needs the payload.
  await d.prisma.$transaction(async (tx) => {
    if (await fn.outboxBeginConsume(tx, deliveryId)) await fn.outboxComplete(tx, deliveryId);
    await scrubAuthPayload(tx, plan.ev.eventId);
  });
  return { status: plan.total === 0 ? 'NO_RECIPIENTS' : 'SENT', sent, skipped: plan.skipped };
}

/** `email.auth` payloads carry OTP codes and reset links: keep only template and recipient after delivery. */
export async function scrubAuthPayload(db: PrismaClient | Prisma.TransactionClient, eventId: number): Promise<number> {
  return db.$executeRaw`
    UPDATE outbox_events e SET payload = jsonb_build_object('template', e.payload->'template', 'to', e.payload->'to', 'scrubbed', true)
     WHERE e.id = ${eventId}::bigint AND e.event_type = 'email.auth' AND NOT (e.payload ? 'scrubbed')
       AND NOT EXISTS (SELECT 1 FROM outbox_deliveries d WHERE d.event_id = e.id AND d.status NOT IN ('COMPLETED', 'DEAD'))`;
}
