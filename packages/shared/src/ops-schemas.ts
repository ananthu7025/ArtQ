// Operations (task 5.8; api.md §4.10, product.md §7.5 "Payment Exceptions" and "Jobs & Webhooks", architecture.md §13).
// Shared by the API and the admin forms (validation rule).
import { z } from 'zod';

export const EXCEPTION_TYPES = [
  'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'EXCESS_CAPTURE', 'LATE_CAPTURE_EXPIRED', 'LATE_CAPTURE_CANCELLED', 'UNLINKED_PAYMENT',
  'CAPTURE_STUCK_AUTHORIZED', 'PROVIDER_ORDER_UNKNOWN', 'REFUND_FAILED', 'REFUND_UNKNOWN', 'WEBHOOK_DEAD', 'OUTBOX_DEAD', 'RECON_MISMATCH',
  'COUPON_OVER_LIMIT', 'OVERSOLD', 'COD_REMITTANCE_MISMATCH', 'REFUND_IDEMPOTENCY_MISMATCH', 'PUBLISHED_NOT_READY', 'PAYMENT_IDENTITY_CONFLICT',
  'REFUNDED_BEFORE_APPLY', 'REFUNDED_OUTSIDE_ARTQ',
] as const;
export type ExceptionTypeValue = (typeof EXCEPTION_TYPES)[number];
export const EXCEPTION_STATUSES = ['OPEN', 'AUTO_RESOLVING', 'RESOLVED', 'DISMISSED'] as const;

/** What each exception means and what to do, in staff words (shown on the exception). */
export const EXCEPTION_HELP: Record<ExceptionTypeValue, { title: string; action: string }> = {
  AMOUNT_MISMATCH: { title: 'Payment amount differs from the order', action: 'Check the payment in Razorpay; refund it or contact the customer.' },
  CURRENCY_MISMATCH: { title: 'Payment in another currency', action: 'Refund the payment in Razorpay and ask the customer to pay again.' },
  EXCESS_CAPTURE: { title: 'Customer paid twice', action: 'The extra payment is refunded automatically; check the refund went through.' },
  LATE_CAPTURE_EXPIRED: { title: 'Paid after the order expired', action: 'Refunded automatically unless the stock could be held again; check the order.' },
  LATE_CAPTURE_CANCELLED: { title: 'Paid after the order was cancelled', action: 'Refunded automatically; check the refund went through.' },
  UNLINKED_PAYMENT: { title: 'Payment not yet matched to an order', action: 'Usually matched within a minute; if not, run a reconcile.' },
  CAPTURE_STUCK_AUTHORIZED: { title: 'Payment authorised but not captured', action: 'Capture or void it in Razorpay, then run a reconcile for the order.' },
  PROVIDER_ORDER_UNKNOWN: { title: 'Razorpay doesn’t know this payment order', action: 'Check the attempt in Razorpay; the order expires normally if unpaid.' },
  REFUND_FAILED: { title: 'Refund failed', action: 'Retry it from the order’s refunds, or refund by bank transfer.' },
  REFUND_UNKNOWN: { title: 'Refund outcome unknown', action: 'Checked again every 5 minutes; look in Razorpay if it stays.' },
  WEBHOOK_DEAD: { title: 'A Razorpay notification could not be processed', action: 'Retry it from Jobs & Webhooks; reconcile the order if it keeps failing.' },
  OUTBOX_DEAD: { title: 'A background task gave up', action: 'Retry it from Jobs & Webhooks after fixing the cause (e.g. email settings).' },
  RECON_MISMATCH: { title: 'Razorpay and ArtQ disagree', action: 'Compare the payment in Razorpay with the order; refunds made in Razorpay are reconciled automatically.' },
  COUPON_OVER_LIMIT: { title: 'Coupon used more than its limit', action: 'Decide whether to honour it; no action needed for the order itself.' },
  OVERSOLD: { title: 'More reserved than in stock', action: 'Recount the stock, or cancel / refund an order.' },
  COD_REMITTANCE_MISMATCH: { title: 'Courier paid a different amount', action: 'Ask the courier about the difference; record the outcome here.' },
  REFUND_IDEMPOTENCY_MISMATCH: { title: 'Refund request conflicts at Razorpay', action: 'Check the refund in Razorpay before doing anything else; never resend it.' },
  PUBLISHED_NOT_READY: { title: 'Live product is missing something', action: 'Open the product and fix what its readiness check lists.' },
  PAYMENT_IDENTITY_CONFLICT: { title: 'Razorpay reported conflicting payment details', action: 'Compare the payment in Razorpay with ArtQ’s record.' },
  REFUNDED_BEFORE_APPLY: { title: 'Payment refunded before ArtQ applied it', action: 'Check the order; a partly refunded payment needs a decision.' },
  REFUNDED_OUTSIDE_ARTQ: { title: 'Refund made in the Razorpay dashboard', action: 'It is recorded; allocate it to items if a credit note is needed.' },
};

export const exceptionListQuery = z.strictObject({
  status: z.enum(EXCEPTION_STATUSES).optional(),
  /** Everything that still needs someone (OPEN or AUTO_RESOLVING). */
  open: z.literal('1').optional(),
  type: z.enum(EXCEPTION_TYPES).optional(),
  orderId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
const note = (what: string) => z.string({ error: `Say ${what}` }).trim().min(3, `Say ${what}`).max(500, 'Use at most 500 characters');
/** POST /admin/payment-exceptions/:id/resolve: what was done. */
export const exceptionResolveBody = z.strictObject({ resolution: note('what you did') });
/** POST /admin/payment-exceptions/:id/dismiss: why nothing needs doing. */
export const exceptionDismissBody = z.strictObject({ note: note('why it needs no action') });
/** POST /admin/payments/reconcile: one order now, or the regular sweep (attempts and refunds) now. */
export const reconcileBody = z.strictObject({ orderId: z.number().int().positive().optional() });

export type AdminExceptionRow = {
  id: number; type: ExceptionTypeValue; status: (typeof EXCEPTION_STATUSES)[number]; createdAt: string; ageMinutes: number;
  amount: number | null; order: { id: number; orderNumber: string } | null; refundId: number | null; paymentId: string | null;
  details: Record<string, unknown>; resolution: string | null; resolvedAt: string | null; resolvedBy: string | null;
};

export const OPS_WEBHOOK_STATUSES = ['RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD', 'IGNORED'] as const;
export const OPS_OUTBOX_STATUSES = ['PENDING', 'LEASED', 'PUBLISHED', 'COMPLETED', 'DEAD'] as const;
export const opsWebhookQuery = z.strictObject({
  status: z.enum(OPS_WEBHOOK_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const opsOutboxQuery = z.strictObject({
  /** `STUCK` = PUBLISHED but not completed for over 30 minutes, or PENDING/LEASED for over 5. */
  status: z.enum([...OPS_OUTBOX_STATUSES, 'STUCK']).optional(),
  consumer: z.string().trim().min(1).max(40).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type OpsAlert = { key: string; severity: 'P1' | 'P2' | 'P3'; title: string; detail: string };
export type OpsSummary = {
  alerts: OpsAlert[];
  queues: { name: string; waiting: number; active: number; delayed: number; failed: number; completed: number }[] | null;
  webhooks: Record<string, number>;
  outbox: { consumer: string; pending: number; leased: number; published: number; stuck: number; dead: number }[];
  searchQueue: { depth: number; oldestMinutes: number | null };
  exceptions: { open: number; oldestMinutes: number | null };
  schedulers: { name: string; lastRunAt: string | null; ok: boolean | null; result: string | null }[];
};
export type OpsWebhookRow = { id: number; provider: string; eventId: string; eventType: string; status: string; attempts: number; lastError: string | null; receivedAt: string; nextAttemptAt: string; processedAt: string | null };
export type OpsOutboxRow = { id: number; consumer: string; eventType: string; aggregate: string; status: string; generation: number; lastError: string | null; createdAt: string; publishedAt: string | null; nextAttemptAt: string };
export type OpsFailedJob = { queue: string; id: string; name: string; failedReason: string | null; attemptsMade: number; failedAt: string | null };
