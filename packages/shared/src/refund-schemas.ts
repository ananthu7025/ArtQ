// Admin refunds (task 5.4; api.md §4.7, architecture.md §10.2, database.md §4.5). Shared by the API and the refund
// form (validation rule). Money in paise. Cancellation and return refunds are created by those flows; staff create
// goodwill and price-adjustment refunds here, allocated to items, shipping and the COD fee.
import { z } from 'zod';

export const ADMIN_REFUND_KINDS = ['GOODWILL', 'PRICE_ADJUSTMENT'] as const;
export const REFUND_STATUSES = ['REQUESTED', 'PENDING', 'PROCESSED', 'FAILED', 'UNKNOWN', 'CANCELLED'] as const;
export type RefundStatusValue = (typeof REFUND_STATUSES)[number];
const paise = (what: string) => z.number({ error: `Enter ${what}` }).int('Use whole paise').min(0, 'Use 0 or more').max(100_000_000, 'At most ₹10,00,000');

/** POST /admin/orders/:id/refunds (refunds:create + step-up, Idempotency-Key). */
export const refundCreateBody = z.strictObject({
  kind: z.enum(ADMIN_REFUND_KINDS, { error: 'Choose the kind of refund' }),
  items: z.array(z.strictObject({
    orderItemId: z.number().int().positive(),
    /** Units given back (0 for a price adjustment on units the customer keeps). */
    quantity: z.number({ error: 'Enter a quantity' }).int('Use whole units').min(0, 'Use 0 or more').max(10_000, 'At most 10,000'),
    amount: paise('an amount'),
  })).max(100, 'At most 100 items').default([]),
  shippingAmount: paise('the shipping amount').default(0),
  codFeeAmount: paise('the COD fee amount').default(0),
  reason: z.string({ error: 'Say why you are refunding' }).trim().min(3, 'Say why you are refunding').max(300, 'Use at most 300 characters'),
}).superRefine((b, ctx) => {
  const seen = new Set<number>();
  b.items.forEach((it, i) => {
    if (seen.has(it.orderItemId)) ctx.addIssue({ code: 'custom', path: ['items', i, 'orderItemId'], message: 'Each item only once' });
    seen.add(it.orderItemId);
    if (it.amount === 0 && it.quantity > 0) ctx.addIssue({ code: 'custom', path: ['items', i, 'amount'], message: 'Enter the amount for these units' });
  });
  if (b.items.reduce((s, i) => s + i.amount, 0) + b.shippingAmount + b.codFeeAmount === 0) ctx.addIssue({ code: 'custom', path: [], message: 'Enter an amount to refund' });
});
export type RefundCreateInput = z.input<typeof refundCreateBody>;

/** POST /admin/refunds/:id/manual-processed (COD bank / UPI transfer done by staff). */
export const manualRefundBody = z.strictObject({
  manualReference: z.string({ error: 'Enter the bank or UPI reference' }).trim().min(3, 'Enter the bank or UPI reference').max(120, 'Use at most 120 characters'),
});

export const refundListQuery = z.strictObject({
  status: z.enum(REFUND_STATUSES).optional(),
  orderId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** GET /admin/orders/:id/refundable: what can still be refunded, at every level (api.md §4.7). */
export type RefundableView = {
  orderId: number; orderNumber: string;
  /** How a refund would be paid: back to the online payment, or by bank / UPI transfer for COD. Null = not refundable now. */
  method: 'ORIGINAL_PAYMENT' | 'MANUAL_BANK' | null;
  /** Why no refund can be created now (method null), e.g. COD not collected yet. */
  blockedReason: string | null;
  items: { orderItemId: number; name: string; label: string; quantity: number; netAmount: number; reservedQty: number; reservedAmount: number; refundedQty: number; refundedAmount: number; availableQty: number; availableAmount: number }[];
  shipping: { fee: number; reserved: number; available: number };
  codFee: { fee: number; reserved: number; available: number };
  total: { cap: number; reserved: number; refunded: number; available: number };
  payment: { amount: number; reserved: number; refunded: number; providerRefunded: number; available: number; reconciliationRequired: boolean } | null;
};

export type AdminRefundRow = {
  id: number; orderId: number; orderNumber: string; kind: string; method: string; status: RefundStatusValue; amount: number;
  itemsAmount: number; shippingAmount: number; codFeeAmount: number; reason: string | null; failureReason: string | null; manualReference: string | null;
  createdAt: string; sentAt: string | null; processedAt: string | null;
  attempts: { no: number; key: string; receipt: string; status: string; lastHttpStatus: number | null; sendCount: number }[];
  /** What staff can do now. */
  actions: ('retry' | 'manual-processed' | 'cancel')[];
};
