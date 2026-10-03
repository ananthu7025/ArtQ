// Thin typed wrappers for the database functions in migration 0003_money_stock_functions (docs/database.md §6b).
// The SQL functions ARE the implementation of the money and stock transactions: these wrappers only bind
// parameters, narrow result types and map raised errors to DbFunctionError. No logic is re-implemented here.
//
// Every wrapper takes the caller's client: pass the interactive-transaction client (`prisma.$transaction(async (tx) => …)`)
// whenever the call is part of a larger transaction; the lock order in docs/database.md §4.1 is the caller's job.
import { Prisma, type PrismaClient } from '@prisma/client';
import { rethrowDbError } from './errors.js';

export type Db = PrismaClient | Prisma.TransactionClient;

export type ActorType = 'CUSTOMER' | 'ADMIN' | 'SYSTEM' | 'WEBHOOK';
export type StatusDimension = 'ORDER' | 'PAYMENT' | 'FULFILMENT' | 'RETURN';
export type UserRole = 'CUSTOMER' | 'STAFF' | 'ADMIN' | 'SUPER_ADMIN';
export type RefundKind = 'CANCELLATION' | 'RETURN' | 'GOODWILL' | 'EXCESS_CAPTURE' | 'LATE_CAPTURE' | 'PRICE_ADJUSTMENT' | 'PROVIDER_INITIATED';
export type ExceptionType =
  | 'AMOUNT_MISMATCH' | 'CURRENCY_MISMATCH' | 'EXCESS_CAPTURE' | 'LATE_CAPTURE_EXPIRED' | 'LATE_CAPTURE_CANCELLED'
  | 'UNLINKED_PAYMENT' | 'CAPTURE_STUCK_AUTHORIZED' | 'PROVIDER_ORDER_UNKNOWN' | 'REFUND_FAILED' | 'REFUND_UNKNOWN'
  | 'WEBHOOK_DEAD' | 'OUTBOX_DEAD' | 'RECON_MISMATCH' | 'COUPON_OVER_LIMIT' | 'OVERSOLD' | 'COD_REMITTANCE_MISMATCH'
  | 'REFUND_IDEMPOTENCY_MISMATCH' | 'PUBLISHED_NOT_READY' | 'PAYMENT_IDENTITY_CONFLICT' | 'REFUNDED_BEFORE_APPLY'
  | 'REFUNDED_OUTSIDE_ARTQ';

const json = (v: unknown) => Prisma.sql`${JSON.stringify(v)}::jsonb`;

async function scalar<T>(db: Db, query: Prisma.Sql): Promise<T> {
  try {
    const rows = await db.$queryRaw<{ r: T }[]>(query);
    return rows[0]!.r;
  } catch (e) {
    return rethrowDbError(e);
  }
}

async function rows<T>(db: Db, query: Prisma.Sql): Promise<T[]> {
  try {
    return await db.$queryRaw<T[]>(query);
  } catch (e) {
    return rethrowDbError(e);
  }
}

async function exec(db: Db, query: Prisma.Sql): Promise<void> {
  try {
    await db.$executeRaw(query);
  } catch (e) {
    rethrowDbError(e);
  }
}

/** BIGINT ids come back as bigint; ArtQ ids stay far below 2^53. */
function toId(v: bigint | number): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`id ${String(v)} exceeds Number.MAX_SAFE_INTEGER`);
  return n;
}

// ── Helpers used by services ─────────────────────────────────────────────

export function history(db: Db, a: { orderId: number; dimension: StatusDimension; from: string | null; to: string; actor: ActorType; note?: string | null }) {
  return exec(db, Prisma.sql`SELECT aq_history(${a.orderId}::int, ${a.dimension}, ${a.from}::text, ${a.to}, ${a.actor}, ${a.note ?? null}::text)`);
}

/** Writes one outbox event plus one delivery per consumer in the caller's transaction. Returns the event id. */
export async function emit(db: Db, a: { aggregateType: string; aggregateId: string; type: string; payload: unknown; consumers: string[] }) {
  return toId(await scalar<bigint>(db, Prisma.sql`SELECT aq_emit(${a.aggregateType}, ${a.aggregateId}, ${a.type}, ${json(a.payload)}, ${a.consumers}::text[]) AS r`));
}

/** Records a payment exception once per dedupe key. Returns false when it already existed. */
export function raiseException(db: Db, a: { type: ExceptionType; dedupeKey: string; orderId?: number | null; paymentId?: number | null; refundId?: number | null; amount?: number | null; details?: unknown }) {
  return scalar<boolean>(db, Prisma.sql`SELECT aq_raise_exception(${a.type}, ${a.dedupeKey}, ${a.orderId ?? null}::int, ${a.paymentId ?? null}::int,
    ${a.refundId ?? null}::int, ${a.amount ?? null}::int, ${a.details === undefined ? null : JSON.stringify(a.details)}::jsonb) AS r`);
}

export function refreshProducts(db: Db, productIds: number[]) {
  return exec(db, Prisma.sql`SELECT aq_refresh_products(${productIds}::int[])`);
}

// ── Idempotency (api.md §1.2, database.md §8.1) ──────────────────────────

export type IdempotencyKey = { scope: string; operation: string; key: string };
export type IdempotencyBegin =
  | { outcome: 'NEW'; ownerToken: string; generation: number }
  | { outcome: 'TAKEOVER'; ownerToken: string; generation: number; resourceType: string | null; resourceId: string | null }
  | { outcome: 'REPLAY'; responseCode: number; responseBody: unknown; resourceType: string | null; resourceId: string | null }
  | { outcome: 'IN_PROGRESS'; responseCode: 409 }
  | { outcome: 'CONFLICT'; responseCode: 422 };

type BeginRow = { outcome: string; response_code: number | null; response_body: unknown; resource_type: string | null; resource_id: string | null; owner_token: string | null; generation: number | null };

export async function idempotencyBegin(db: Db, k: IdempotencyKey & { target: string; requestHash: string; lockSeconds?: number }): Promise<IdempotencyBegin> {
  const [r] = await rows<BeginRow>(db, Prisma.sql`SELECT * FROM aq_idempotency_begin(${k.scope}, ${k.operation}, ${k.key}, ${k.target}, ${k.requestHash}, ${k.lockSeconds ?? 60}::int)`);
  switch (r!.outcome) {
    case 'NEW': return { outcome: 'NEW', ownerToken: r!.owner_token!, generation: r!.generation! };
    case 'TAKEOVER': return { outcome: 'TAKEOVER', ownerToken: r!.owner_token!, generation: r!.generation!, resourceType: r!.resource_type, resourceId: r!.resource_id };
    case 'REPLAY': return { outcome: 'REPLAY', responseCode: r!.response_code!, responseBody: r!.response_body, resourceType: r!.resource_type, resourceId: r!.resource_id };
    case 'IN_PROGRESS': return { outcome: 'IN_PROGRESS', responseCode: 409 };
    case 'CONFLICT': return { outcome: 'CONFLICT', responseCode: 422 };
    default: throw new Error(`aq_idempotency_begin: unexpected outcome ${r!.outcome}`);
  }
}

/** First statement of every guarded transaction. Raises IDEMPOTENCY_OWNERSHIP_LOST when superseded. */
export function idempotencyAssertOwner(db: Db, k: IdempotencyKey & { ownerToken: string }) {
  return exec(db, Prisma.sql`SELECT aq_idempotency_assert_owner(${k.scope}, ${k.operation}, ${k.key}, ${k.ownerToken}::uuid)`);
}

export function idempotencyAttach(db: Db, k: IdempotencyKey & { ownerToken: string; resourceType: string; resourceId: string }) {
  return exec(db, Prisma.sql`SELECT aq_idempotency_attach(${k.scope}, ${k.operation}, ${k.key}, ${k.ownerToken}::uuid, ${k.resourceType}, ${k.resourceId})`);
}

/** Extends the PROCESSING lock. false ⇒ a newer owner is in charge: stop. */
export function idempotencyRenew(db: Db, k: IdempotencyKey & { ownerToken: string; lockSeconds?: number }) {
  return scalar<boolean>(db, Prisma.sql`SELECT aq_idempotency_renew(${k.scope}, ${k.operation}, ${k.key}, ${k.ownerToken}::uuid, ${k.lockSeconds ?? 60}::int) AS r`);
}

export function idempotencyComplete(db: Db, k: IdempotencyKey & { ownerToken: string; responseCode: number; responseBody: unknown; resourceType?: string | null; resourceId?: string | null }) {
  return exec(db, Prisma.sql`SELECT aq_idempotency_complete(${k.scope}, ${k.operation}, ${k.key}, ${k.ownerToken}::uuid, ${k.responseCode}::int,
    ${json(k.responseBody)}, ${k.resourceType ?? null}::text, ${k.resourceId ?? null}::text)`);
}

// ── Stock & orders ───────────────────────────────────────────────────────

/** Reserves stock for every line of the order. Raises OUT_OF_STOCK:<variantId>. */
export function reserveOrder(db: Db, orderId: number) {
  return exec(db, Prisma.sql`SELECT aq_reserve_order(${orderId}::int)`);
}

/** Re-reserves stock for a late payment on an expired order. false ⇒ not enough stock. */
export function reacquireOrder(db: Db, orderId: number) {
  return scalar<boolean>(db, Prisma.sql`SELECT aq_reacquire_order(${orderId}::int) AS r`);
}

export function releaseUnpaidOrder(db: Db, a: { orderId: number; newStatus: 'EXPIRED' | 'CANCELLED'; reason: string; actor: ActorType }) {
  return scalar<'EXPIRED' | 'CANCELLED' | 'SKIPPED'>(db, Prisma.sql`SELECT aq_release_unpaid_order(${a.orderId}::int, ${a.newStatus}, ${a.reason}, ${a.actor}) AS r`);
}

export type OnHandAdjustment = { variantId: number; kind: 'RECOUNT' | 'ADJUSTMENT' | 'DAMAGE_WRITE_OFF'; quantity: number; note?: string };

/** Physical stock changes. Raises NOT_FOUND:variant:<id> or INVALID_ADJUSTMENT:<id>. */
export function adjustOnHand(db: Db, a: { rows: OnHandAdjustment[]; actorId: number | null; importId?: number | null }) {
  const payload = a.rows.map((r) => ({ variant_id: r.variantId, kind: r.kind, quantity: r.quantity, note: r.note ?? null }));
  return exec(db, Prisma.sql`SELECT aq_adjust_on_hand(${json(payload)}, ${a.actorId}::int, ${a.importId ?? null}::int)`);
}

/**
 * Catalogue import (migration 0004): initial on_hand of a variant the import just created; IMPORT_INITIAL movement;
 * stays uncounted. Raises STOCK_ALREADY_SET for a variant with stock or history. Caller refreshes aggregates.
 */
export function importInitialStock(db: Db, a: { variantId: number; quantity: number; importId: number; actorId: number | null }) {
  return exec(db, Prisma.sql`SELECT aq_import_initial_stock(${a.variantId}::int, ${a.quantity}::int, ${a.importId}::int, ${a.actorId}::int)`);
}

export function editVariants(db: Db, productId: number, edits: { variantId: number; color?: string | null; isActive?: boolean | null }[]) {
  const payload = edits.map((e) => ({ variant_id: e.variantId, color: e.color ?? null, is_active: e.isActive ?? null }));
  return exec(db, Prisma.sql`SELECT aq_edit_variants(${productId}::int, ${json(payload)})`);
}

/** Drains the search reindex queue. Returns the number of products reindexed. */
export function processSearchQueue(db: Db, limit = 500) {
  return scalar<number>(db, Prisma.sql`SELECT aq_process_search_queue(${limit}::int) AS r`);
}

/** Raises COUPON_INVALID or COUPON_USAGE_EXCEEDED:customer|total. */
export function reserveCoupon(db: Db, a: { orderId: number; couponId: number; userId: number | null; email: string; phone: string | null; discount: number }) {
  return exec(db, Prisma.sql`SELECT aq_reserve_coupon(${a.orderId}::int, ${a.couponId}::int, ${a.userId}::int, ${a.email}, ${a.phone}::text, ${a.discount}::int)`);
}

/** Migration 0006 (D-14): REDEEMED → REVERSED and redeemed_count − 1 for a CANCELLED order; false when nothing to reverse. */
export function reverseCoupon(db: Db, orderId: number) {
  return scalar<boolean>(db, Prisma.sql`SELECT aq_reverse_coupon(${orderId}::int) AS r`);
}

/** Migration 0007: a pending COD order → PLACED + COD_PENDING (coupon redeemed, cart converted, order.placed); 'DUPLICATE' if already. Raises INVALID_TRANSITION. */
export function placeCodOrder(db: Db, orderId: number, actor: ActorType) {
  return scalar<'PLACED' | 'DUPLICATE'>(db, Prisma.sql`SELECT aq_place_cod_order(${orderId}::int, ${actor}) AS r`);
}

// ── Payments ─────────────────────────────────────────────────────────────

export function reassessOrderPayment(db: Db, orderId: number, actor: ActorType) {
  return scalar<'UNCHANGED' | 'PROCESSING' | 'UNPAID'>(db, Prisma.sql`SELECT aq_reassess_order_payment(${orderId}::int, ${actor}) AS r`);
}

export type ProviderPaymentStatus = 'CREATED' | 'FAILED' | 'AUTHORIZED' | 'CAPTURED' | 'REFUNDED';
export type ApplyPaymentOutcome = 'APPLIED' | 'AUTHORIZED' | 'NOT_CAPTURED' | 'DUPLICATE' | 'CONFLICT' | 'UNLINKED' | 'VOID' | 'HELD';

/** Single entry point for verify, webhook and reconciliation (database.md §8.2). Input is the provider's authoritative snapshot. */
export function applyProviderPayment(db: Db, p: {
  providerOrderId: string; paymentId: string; amount: number; currency: string; status: ProviderPaymentStatus;
  amountRefunded: number; capturedAt: Date | null; method: string | null; raw: unknown; actor: ActorType;
}) {
  return scalar<ApplyPaymentOutcome>(db, Prisma.sql`SELECT aq_apply_provider_payment(${p.providerOrderId}, ${p.paymentId}, ${p.amount}::int, ${p.currency},
    ${p.status}, ${p.amountRefunded}::int, ${p.capturedAt}::timestamptz, ${p.method}::text, ${json(p.raw)}, ${p.actor}) AS r`);
}

// ── Refunds (database.md §8.5) ───────────────────────────────────────────

/** Reserves (+1) or releases (−1) refund capacity. Normally called by the refund functions themselves. */
export function refundCapacity(db: Db, refundId: number, sign: 1 | -1) {
  return exec(db, Prisma.sql`SELECT aq_refund_capacity(${refundId}::int, ${sign}::int)`);
}

/** Creates the next provider attempt (new key + receipt). Returns the attempt id, or null for manual refunds. */
export function newRefundAttempt(db: Db, refundId: number) {
  return scalar<number | null>(db, Prisma.sql`SELECT aq_new_refund_attempt(${refundId}::int) AS r`);
}

export type RefundItemInput = { orderItemId: number; quantity: number; amount: number; taxAmount?: number };

/** Creates a refund and reserves capacity atomically. Returns the refund id. */
export function requestRefund(db: Db, a: {
  orderId: number; paymentId: number | null; kind: RefundKind; items: RefundItemInput[]; shipping: number; codFee: number;
  unallocated: number; reason: string; idempotencyKey: string; requestedBy: number | null;
}) {
  const items = a.items.map((i) => ({ order_item_id: i.orderItemId, quantity: i.quantity, amount: i.amount, tax_amount: i.taxAmount ?? 0 }));
  return scalar<number>(db, Prisma.sql`SELECT aq_request_refund(${a.orderId}::int, ${a.paymentId}::int, ${a.kind}, ${json(items)}, ${a.shipping}::int,
    ${a.codFee}::int, ${a.unallocated}::int, ${a.reason}, ${a.idempotencyKey}, ${a.requestedBy}::int) AS r`);
}

/** Retries a FAILED refund. Returns the new attempt NUMBER (refunds.attempt_no). Raises REFUND_NOT_RETRYABLE. */
export function retryRefund(db: Db, refundId: number) {
  return scalar<number>(db, Prisma.sql`SELECT aq_retry_refund(${refundId}::int) AS r`);
}

export type RefundAttemptOutcome = 'ACCEPTED_PENDING' | 'ACCEPTED_PROCESSED' | 'UNKNOWN' | 'IN_PROGRESS' | 'MISMATCH' | 'FAILED';

export function refundAttemptResult(db: Db, a: { attemptId: number; outcome: RefundAttemptOutcome; httpStatus: number | null; response: unknown; providerRefundId: string | null }) {
  return scalar<'STALE' | 'PENDING' | 'UNKNOWN' | 'MISMATCH' | 'FAILED' | 'PROCESSED' | 'DUPLICATE'>(db,
    Prisma.sql`SELECT aq_refund_attempt_result(${a.attemptId}::int, ${a.outcome}, ${a.httpStatus}::int, ${json(a.response)}, ${a.providerRefundId}::text) AS r`);
}

export function markRefundProcessed(db: Db, refundId: number, providerRefundId: string | null) {
  return scalar<'PROCESSED' | 'DUPLICATE'>(db, Prisma.sql`SELECT aq_mark_refund_processed(${refundId}::int, ${providerRefundId}::text) AS r`);
}

export type ProviderRefund = { id: string; amount: number; status: string; receipt?: string | null; notes?: { aq_refund_id?: string | number } | null };

export function reconcileProviderRefunds(db: Db, paymentId: number, refunds: ProviderRefund[]) {
  return scalar<'UNBOUND' | 'INCONSISTENT' | 'RECONCILED' | 'STILL_UNEXPLAINED'>(db,
    Prisma.sql`SELECT aq_reconcile_provider_refunds(${paymentId}::int, ${json(refunds)}) AS r`);
}

/** Cancels a REQUESTED manual (COD bank) refund. Raises REFUND_NOT_CANCELLABLE. */
export function cancelManualRefund(db: Db, refundId: number) {
  return exec(db, Prisma.sql`SELECT aq_cancel_manual_refund(${refundId}::int)`);
}

// ── Webhook inbox leases (database.md §8.6) ──────────────────────────────

/** Returns the lease token, or null when another worker owns the event or it is not due. */
export function webhookClaim(db: Db, eventId: number, leaseSeconds = 300) {
  return scalar<string | null>(db, Prisma.sql`SELECT aq_webhook_claim(${eventId}::int, ${leaseSeconds}::int) AS r`);
}

export function webhookBegin(db: Db, eventId: number, token: string) {
  return scalar<boolean>(db, Prisma.sql`SELECT aq_webhook_begin(${eventId}::int, ${token}::uuid) AS r`);
}

export function webhookRenew(db: Db, eventId: number, token: string, leaseSeconds = 300) {
  return scalar<boolean>(db, Prisma.sql`SELECT aq_webhook_renew(${eventId}::int, ${token}::uuid, ${leaseSeconds}::int) AS r`);
}

/** Raises LEASE_LOST so the surrounding domain transaction rolls back. */
export function webhookComplete(db: Db, eventId: number, token: string, final: 'PROCESSED' | 'IGNORED' = 'PROCESSED') {
  return exec(db, Prisma.sql`SELECT aq_webhook_complete(${eventId}::int, ${token}::uuid, ${final})`);
}

export function webhookFail(db: Db, eventId: number, token: string, error: string) {
  return scalar<'FAILED' | 'DEAD' | 'LEASE_LOST'>(db, Prisma.sql`SELECT aq_webhook_fail(${eventId}::int, ${token}::uuid, ${error}) AS r`);
}

// ── Outbox deliveries (database.md §8.7) ─────────────────────────────────

export type OutboxClaim = { deliveryId: number; consumer: string; generation: number; leaseToken: string; eventId: number; eventType: string; payload: unknown };

export async function outboxClaim(db: Db, a: { limit: number; leaseSeconds: number; redeliverSeconds: number; maxGenerations: number }): Promise<OutboxClaim[]> {
  const r = await rows<{ delivery_id: bigint; consumer: string; generation: number; lease_token: string; event_id: bigint; event_type: string; payload: unknown }>(db,
    Prisma.sql`SELECT * FROM aq_outbox_claim(${a.limit}::int, ${a.leaseSeconds}::int, ${a.redeliverSeconds}::int, ${a.maxGenerations}::int)`);
  return r.map((x) => ({ deliveryId: toId(x.delivery_id), consumer: x.consumer, generation: x.generation, leaseToken: x.lease_token,
    eventId: toId(x.event_id), eventType: x.event_type, payload: x.payload }));
}

/** false ⇒ the lease was lost; the newer owner handles the delivery. */
export function outboxMarkPublished(db: Db, deliveryId: number, token: string) {
  return scalar<boolean>(db, Prisma.sql`SELECT aq_outbox_mark_published(${deliveryId}::bigint, ${token}::uuid) AS r`);
}

export function outboxPublishFailed(db: Db, deliveryId: number, token: string, error: string) {
  return scalar<boolean>(db, Prisma.sql`SELECT aq_outbox_publish_failed(${deliveryId}::bigint, ${token}::uuid, ${error}) AS r`);
}

/** false ⇒ already COMPLETED or DEAD: acknowledge the job and do nothing. */
export function outboxBeginConsume(db: Db, deliveryId: number) {
  return scalar<boolean>(db, Prisma.sql`SELECT aq_outbox_begin_consume(${deliveryId}::bigint) AS r`);
}

export function outboxComplete(db: Db, deliveryId: number) {
  return scalar<boolean>(db, Prisma.sql`SELECT aq_outbox_complete(${deliveryId}::bigint) AS r`);
}

// ── Sessions (architecture.md §5.4) ──────────────────────────────────────

export function sessionValid(db: Db, sessionId: string) {
  return scalar<boolean>(db, Prisma.sql`SELECT aq_session_valid(${sessionId}::uuid) AS r`);
}

export function changeRole(db: Db, userId: number, role: UserRole) {
  return exec(db, Prisma.sql`SELECT aq_change_role(${userId}::int, ${role})`);
}

export function revokeAllSessions(db: Db, userId: number, reason: string, block = false) {
  return exec(db, Prisma.sql`SELECT aq_revoke_all_sessions(${userId}::int, ${reason}, ${block})`);
}
