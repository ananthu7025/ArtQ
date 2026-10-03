// Retention (architecture.md §8.2 outbox; database.md §3.1 auth tables; tasklist 1.8). Runs hourly in the worker.
// Every statement deletes in bounded batches so a large backlog never holds long locks.
import type { PrismaClient } from '@prisma/client';

export const RETENTION = {
  outboxCompletedDays: 30,      // COMPLETED deliveries; DEAD ones stay until resolved
  sessionDays: 30,              // sessions (and their refresh-token history) after they end
  otpGraceHours: 24,            // codes after expiry or use
  resetTokenGraceHours: 24,     // password-reset links after expiry or use
  deletedAccountDays: 30,       // deleted accounts: personal data removed after this (api.md §3.5); orders keep their own copy
  emailAuthScrubMinutes: 60,    // email.auth payloads whose deliveries all finished but were not scrubbed in-line
  batch: 5000,
} as const;

export type RetentionResult = Record<'outboxDeliveries' | 'outboxEvents' | 'emailPayloadsScrubbed' | 'sessions' | 'otpCodes' | 'resetTokens' | 'idempotencyKeys' | 'accountsAnonymised', number>;

async function batched(run: () => Promise<number>, batch: number): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await run();
    total += n;
    if (n < batch) return total;
  }
}

export async function runRetention(prisma: PrismaClient, o: Partial<typeof RETENTION> = {}): Promise<RetentionResult> {
  const r = { ...RETENTION, ...o };
  const outboxDeliveries = await batched(() => prisma.$executeRaw`
    DELETE FROM outbox_deliveries WHERE id IN (
      SELECT id FROM outbox_deliveries WHERE status = 'COMPLETED' AND completed_at < now() - make_interval(days => ${r.outboxCompletedDays}::int)
      LIMIT ${r.batch}::int)`, r.batch);
  const outboxEvents = await batched(() => prisma.$executeRaw`
    DELETE FROM outbox_events WHERE id IN (
      SELECT e.id FROM outbox_events e WHERE e.created_at < now() - make_interval(days => ${r.outboxCompletedDays}::int)
         AND NOT EXISTS (SELECT 1 FROM outbox_deliveries d WHERE d.event_id = e.id) LIMIT ${r.batch}::int)`, r.batch);
  const emailPayloadsScrubbed = await prisma.$executeRaw`
    UPDATE outbox_events e SET payload = jsonb_build_object('template', e.payload->'template', 'to', e.payload->'to', 'scrubbed', true)
     WHERE e.event_type = 'email.auth' AND NOT (e.payload ? 'scrubbed')
       AND (e.created_at < now() - make_interval(mins => ${r.emailAuthScrubMinutes}::int))
       AND NOT EXISTS (SELECT 1 FROM outbox_deliveries d WHERE d.event_id = e.id AND d.status NOT IN ('COMPLETED', 'DEAD'))`;
  // Sessions cascade to refresh_tokens: history is kept for the session's life + 30 days (database.md §3.1).
  const sessions = await batched(() => prisma.$executeRaw`
    DELETE FROM sessions WHERE id IN (
      SELECT id FROM sessions
       WHERE coalesce(revoked_at, least(idle_expires_at, absolute_expires_at)) < now() - make_interval(days => ${r.sessionDays}::int)
       LIMIT ${r.batch}::int)`, r.batch);
  const otpCodes = await batched(() => prisma.$executeRaw`
    DELETE FROM otp_codes WHERE id IN (
      SELECT id FROM otp_codes WHERE greatest(expires_at, coalesce(consumed_at, expires_at)) < now() - make_interval(hours => ${r.otpGraceHours}::int)
      LIMIT ${r.batch}::int)`, r.batch);
  const resetTokens = await batched(() => prisma.$executeRaw`
    DELETE FROM password_reset_tokens WHERE id IN (
      SELECT id FROM password_reset_tokens WHERE greatest(expires_at, coalesce(used_at, expires_at)) < now() - make_interval(hours => ${r.resetTokenGraceHours}::int)
      LIMIT ${r.batch}::int)`, r.batch);
  // Idempotency records expire 24 h after creation (api.md §1.2); a still-PROCESSING one past expiry is abandoned.
  const idempotencyKeys = await batched(() => prisma.$executeRaw`
    DELETE FROM idempotency_keys WHERE id IN (SELECT id FROM idempotency_keys WHERE expires_at < now() LIMIT ${r.batch}::int)`, r.batch);
  // Deleted accounts (task 4.2): after 30 days the person's details go; the row stays (orders and audit refer to it).
  // The email becomes a unique placeholder, so the address can sign up again and the row is recognisably anonymised.
  const accountsAnonymised = await prisma.$transaction(async (tx) => {
    const ids = (await tx.$queryRaw<{ id: number }[]>`
      SELECT id FROM users WHERE deleted_at < now() - make_interval(days => ${r.deletedAccountDays}::int)
         AND email NOT LIKE 'deleted-%@deleted.invalid' LIMIT ${r.batch}::int FOR UPDATE SKIP LOCKED`).map((x) => x.id);
    if (ids.length === 0) return 0;
    await tx.$executeRaw`DELETE FROM addresses WHERE user_id = ANY(${ids})`;
    await tx.$executeRaw`DELETE FROM wishlist_items WHERE user_id = ANY(${ids})`;
    await tx.$executeRaw`UPDATE users SET name = NULL, phone = NULL, password_hash = NULL, marketing_opt_in = false,
        email = 'deleted-' || id || '@deleted.invalid' WHERE id = ANY(${ids})`;
    return ids.length;
  });
  return { outboxDeliveries, outboxEvents, emailPayloadsScrubbed, sessions, otpCodes, resetTokens, idempotencyKeys, accountsAnonymised };
}
