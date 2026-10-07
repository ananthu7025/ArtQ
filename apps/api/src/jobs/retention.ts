// Retention (architecture.md §8.2 outbox; database.md §3.1 auth tables; tasklist 1.8). Runs hourly in the worker.
// Every statement deletes in bounded batches so a large backlog never holds long locks.
import { Prisma, type PrismaClient } from '@prisma/client';

export const RETENTION = {
  outboxCompletedDays: 30,      // COMPLETED deliveries; DEAD ones stay until resolved
  sessionDays: 30,              // sessions (and their refresh-token history) after they end
  otpGraceHours: 24,            // codes after expiry or use
  resetTokenGraceHours: 24,     // password-reset links after expiry or use
  deletedAccountDays: 30,       // deleted accounts: personal data removed after this (api.md §3.5); orders keep their own copy
  emailAuthScrubMinutes: 60,    // email.auth payloads whose deliveries all finished but were not scrubbed in-line
  guestCartDays: 30,            // guest carts (and merged / abandoned ones) after their last activity (product.md §5.5; the cookie lives as long)
  batch: 5000,
} as const;

export type RetentionResult = Record<'outboxDeliveries' | 'outboxEvents' | 'emailPayloadsScrubbed' | 'sessions' | 'otpCodes' | 'resetTokens' | 'idempotencyKeys' | 'accountsAnonymised' | 'cartsDeleted' | 'cartsStripped', number>;

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
  const { cartsDeleted, cartsStripped } = await cleanCarts(prisma, r.guestCartDays, r.batch);
  return { outboxDeliveries, outboxEvents, emailPayloadsScrubbed, sessions, otpCodes, resetTokens, idempotencyKeys, accountsAnonymised, cartsDeleted, cartsStripped };
}

/**
 * Abandoned carts (task 4.1). A cart is stale when nobody has touched it for `days` and it is a guest cart or no longer
 * the account's active cart; an account's ACTIVE cart is kept as long as the account. Stale carts that never became an
 * order are deleted (items cascade). Stale carts that did are kept, because a guest reaches their order with that
 * cart's cookie, but lose their items, coupon, pincode and the unverified checkout contact; an ACTIVE one becomes
 * ABANDONED. A cart with an order still waiting for payment is never touched.
 */
async function cleanCarts(prisma: PrismaClient, days: number, batch: number): Promise<{ cartsDeleted: number; cartsStripped: number }> {
  const stale = Prisma.sql`c.last_activity_at < now() - make_interval(days => ${days}::int) AND (c.user_id IS NULL OR c.status <> 'ACTIVE')`;
  const cartsDeleted = await batched(() => prisma.$executeRaw`
    DELETE FROM carts WHERE id IN (
      SELECT c.id FROM carts c WHERE ${stale} AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.cart_id = c.id)
       LIMIT ${batch}::int FOR UPDATE SKIP LOCKED)`, batch);
  const cartsStripped = await batched(() => prisma.$transaction(async (tx) => {
    const ids = (await tx.$queryRaw<{ id: number }[]>`
      SELECT c.id FROM carts c
       WHERE ${stale}
         AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.cart_id = c.id AND o.status = 'PENDING_PAYMENT')
         AND (c.status = 'ACTIVE' OR c.coupon_id IS NOT NULL OR c.contact_email IS NOT NULL OR c.contact_phone IS NOT NULL OR c.pincode IS NOT NULL
              OR EXISTS (SELECT 1 FROM cart_items i WHERE i.cart_id = c.id))
       LIMIT ${batch}::int FOR UPDATE SKIP LOCKED`).map((x) => x.id);
    if (ids.length === 0) return 0;
    await tx.$executeRaw`DELETE FROM cart_items WHERE cart_id = ANY(${ids})`;
    await tx.$executeRaw`UPDATE carts SET status = CASE WHEN status = 'ACTIVE' THEN 'ABANDONED'::"CartStatus" ELSE status END,
        coupon_id = NULL, contact_email = NULL, contact_phone = NULL, pincode = NULL WHERE id = ANY(${ids})`;
    return ids.length;
  }), batch);
  return { cartsDeleted, cartsStripped };
}
