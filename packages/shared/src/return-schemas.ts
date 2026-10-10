// Returns (task 5.5; product.md §8.8, api.md §3.5 and §4.7, database.md §8.5b). Shared by the API and the forms
// (validation rule). Damaged, wrong, defective or missing items only (decision D-5), within the return window after
// delivery, with photos (not needed for a missing item). Staff decide → (in transit) → receive → inspect → refund → close.
import { z } from 'zod';

export const RETURN_REASONS = ['DAMAGED', 'WRONG_ITEM', 'DEFECTIVE', 'MISSING_ITEM'] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];
export const RETURN_REASON_LABEL: Record<ReturnReason | 'OTHER', string> = {
  DAMAGED: 'Arrived damaged', WRONG_ITEM: 'Wrong item sent', DEFECTIVE: 'Defective', MISSING_ITEM: 'Item missing from the parcel', OTHER: 'Other',
};
export const RETURN_REQUEST_STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTED', 'REFUNDED', 'CLOSED', 'CANCELLED'] as const;
export type ReturnRequestStatus = (typeof RETURN_REQUEST_STATUSES)[number];
export const RETURN_PHOTOS_MAX = 6;
export const RETURN_DESCRIPTION_MAX = 1000;
export const RETURN_NOTE_MAX = 500;

const units = (what: string) => z.number({ error: `Enter ${what}` }).int('Use whole units').min(0, 'Use 0 or more').max(10_000, 'At most 10,000');
const itemId = z.number().int().positive();

/** Each item at most once (the issue goes on the repeated entry). */
function uniqueItems(items: { orderItemId: number }[], ctx: z.RefinementCtx) {
  const seen = new Set<number>();
  items.forEach((it, i) => {
    if (seen.has(it.orderItemId)) ctx.addIssue({ code: 'custom', path: ['items', i, 'orderItemId'], message: 'Each item only once' });
    seen.add(it.orderItemId);
  });
}

/** POST /me/orders/:orderNumber/returns (and the guest route): Idempotency-Key. */
export const customerReturnBody = z.strictObject({
  reason: z.enum(RETURN_REASONS, { error: 'Choose what went wrong' }),
  description: z.string().trim().max(RETURN_DESCRIPTION_MAX, `Use at most ${RETURN_DESCRIPTION_MAX.toLocaleString('en-IN')} characters`).transform((v) => v || null).nullable().default(null),
  items: z.array(z.strictObject({
    orderItemId: itemId,
    quantity: z.number({ error: 'Enter how many' }).int('Use whole units').min(1, 'Return at least 1').max(10_000, 'At most 10,000'),
  }), { error: 'Choose the items' }).min(1, 'Choose at least one item').max(100, 'At most 100 items'),
  mediaIds: z.array(z.number().int().positive()).max(RETURN_PHOTOS_MAX, `At most ${RETURN_PHOTOS_MAX} photos`).default([]),
}).superRefine((b, ctx) => {
  uniqueItems(b.items, ctx);
  if (new Set(b.mediaIds).size !== b.mediaIds.length) ctx.addIssue({ code: 'custom', path: ['mediaIds'], message: 'Each photo only once' });
  if (b.reason !== 'MISSING_ITEM' && b.mediaIds.length === 0) ctx.addIssue({ code: 'custom', path: ['mediaIds'], message: 'Add at least one photo of the problem' });
});
export type CustomerReturnInput = z.input<typeof customerReturnBody>;

/** POST /me/orders/:orderNumber/uploads/presign: a return photo (images up to 8 MB, private). */
export const returnPhotoPresignBody = z.strictObject({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().toLowerCase().max(120),
  size: z.number().int().positive(),
});

export const returnListQuery = z.strictObject({
  status: z.enum(RETURN_REQUEST_STATUSES).optional(),
  /** Everything that still needs staff (requested, approved, in transit, received, inspected, refunded). */
  open: z.literal('1').optional(),
  orderId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const note = z.string().trim().max(RETURN_NOTE_MAX, `Use at most ${RETURN_NOTE_MAX} characters`);

/** POST /admin/returns/:id/decide [returns:decide]. A rejection explains itself to the customer. */
export const returnDecideBody = z.strictObject({
  decision: z.enum(['APPROVE', 'REJECT'], { error: 'Choose approve or reject' }),
  items: z.array(z.strictObject({ orderItemId: itemId, approvedQty: units('how many to approve') })).max(100).default([]),
  note: note.transform((v) => v || null).nullable().default(null),
}).superRefine((b, ctx) => {
  uniqueItems(b.items, ctx);
  if (b.decision === 'APPROVE' && b.items.reduce((s, i) => s + i.approvedQty, 0) === 0) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Approve at least one unit, or reject the return' });
  if (b.decision === 'REJECT' && (b.note ?? '').length < 3) ctx.addIssue({ code: 'custom', path: ['note'], message: 'Tell the customer why (sent in the email)' });
});
export type ReturnDecideInput = z.input<typeof returnDecideBody>;

/** POST /admin/returns/:id/receive [returns:receive]: units that arrived, per approved item. */
export const returnReceiveBody = z.strictObject({
  items: z.array(z.strictObject({ orderItemId: itemId, receivedQty: units('how many arrived') })).min(1).max(100),
}).superRefine((b, ctx) => uniqueItems(b.items, ctx));

/** POST /admin/returns/:id/inspect [returns:receive]: sellable units go back into stock; damaged ones don't. */
export const returnInspectBody = z.strictObject({
  items: z.array(z.strictObject({ orderItemId: itemId, sellableQty: units('the sellable units'), damagedQty: units('the damaged units') })).max(100),
}).superRefine((b, ctx) => uniqueItems(b.items, ctx));

/** POST /admin/returns/:id/in-transit and /close: an optional note. */
export const returnNoteBody = z.strictObject({ note: note.transform((v) => v || null).nullable().default(null) });
/** POST /admin/returns/:id/cancel [returns:decide]: why (e.g. the customer kept it). */
export const returnCancelBody = z.strictObject({
  note: z.string({ error: 'Say why the return is cancelled' }).trim().min(3, 'Say why the return is cancelled').max(RETURN_NOTE_MAX, `Use at most ${RETURN_NOTE_MAX} characters`),
});

const paise = (what: string) => z.number({ error: `Enter ${what}` }).int('Use whole paise').min(0, 'Use 0 or more').max(100_000_000, 'At most ₹10,00,000');
/**
 * POST /admin/returns/:id/refund [refunds:create + step-up], Idempotency-Key: a RETURN refund for units received
 * (approved for a missing item). Shipping at staff discretion (merchant fault); the COD fee is never refunded here.
 */
export const returnRefundBody = z.strictObject({
  items: z.array(z.strictObject({
    orderItemId: itemId,
    quantity: z.number({ error: 'Enter the units' }).int('Use whole units').min(0, 'Use 0 or more').max(10_000, 'At most 10,000'),
    amount: paise('an amount'),
  })).max(100).default([]),
  shippingAmount: paise('the shipping amount').default(0),
  reason: z.string({ error: 'Say why you are refunding' }).trim().min(3, 'Say why you are refunding').max(300, 'Use at most 300 characters'),
}).superRefine((b, ctx) => {
  uniqueItems(b.items, ctx);
  b.items.forEach((it, i) => {
    if (it.amount > 0 && it.quantity === 0) ctx.addIssue({ code: 'custom', path: ['items', i, 'quantity'], message: 'Enter the units refunded' });
    if (it.quantity > 0 && it.amount === 0) ctx.addIssue({ code: 'custom', path: ['items', i, 'amount'], message: 'Enter the amount for these units' });
  });
  if (b.items.filter((i) => i.amount > 0).length === 0) ctx.addIssue({ code: 'custom', path: [], message: 'Refund at least one returned item' });
});
export type ReturnRefundInput = z.input<typeof returnRefundBody>;

export type ReturnAction = 'decide' | 'in-transit' | 'receive' | 'inspect' | 'refund' | 'close' | 'cancel';

export type AdminReturnRow = {
  id: number; orderId: number; orderNumber: string; customerName: string; reason: ReturnReason | 'OTHER'; status: ReturnRequestStatus;
  units: number; createdAt: string; decidedAt: string | null; actions: ReturnAction[];
};

export type AdminReturnDetail = AdminReturnRow & {
  description: string | null; adminNote: string | null; decidedBy: string | null;
  receivedAt: string | null; inspectedAt: string | null; closedAt: string | null;
  deliveredAt: string | null; paymentMethod: 'RAZORPAY' | 'COD';
  items: {
    orderItemId: number; name: string; label: string; sku: string; bought: number; netAmount: number;
    requestedQty: number; approvedQty: number | null; receivedQty: number | null; sellableQty: number | null; damagedQty: number | null;
    /** Units of this item already in this return's live refunds, and what is still refundable for it here. */
    refundedQty: number; refundableQty: number; refundableAmount: number;
  }[];
  /** Short-lived signed links (5 minutes); reload the return for fresh ones. */
  photos: { id: number; url: string; thumbUrl: string | null }[];
  refunds: { id: number; status: string; amount: number; createdAt: string }[];
  /** Shipping still refundable on the order (merchant-fault returns). */
  shippingAvailable: number;
};

/** What the customer gets back after asking for a return. */
export type CustomerReturnView = { id: number; status: ReturnRequestStatus; reason: ReturnReason; items: { orderItemId: number; quantity: number }[]; createdAt: string };
