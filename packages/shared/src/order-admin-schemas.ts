// Admin Orders (task 5.1; api.md §4.3, product.md §7.5 "Orders", database.md §3.9 and §4). Shared by the API and the
// admin forms (validation rule). Money in paise.
import { z } from 'zod';
import { addressBody } from './auth-schemas.js';

export const ORDER_STATUSES = ['PENDING_PAYMENT', 'PLACED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'EXPIRED'] as const;
export const ORDER_PAYMENT_STATUSES = ['UNPAID', 'PROCESSING', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'COD_PENDING', 'COD_COLLECTED', 'COD_REMITTED', 'NOT_COLLECTED'] as const;
export const FULFILMENT_STATUSES = ['UNFULFILLED', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RTO_IN_TRANSIT', 'RTO_RECEIVED', 'LOST'] as const;
export const RETURN_STATUSES = ['NONE', 'OPEN', 'CLOSED'] as const;
export type OrderStatusValue = (typeof ORDER_STATUSES)[number];
export type OrderPaymentStatusValue = (typeof ORDER_PAYMENT_STATUSES)[number];
export type FulfilmentStatusValue = (typeof FULFILMENT_STATUSES)[number];
export type ReturnStatusValue = (typeof RETURN_STATUSES)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-05').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Use a real date');

/** GET /admin/orders. `from`/`to` are calendar days (India time) of when the order was created, both inclusive. */
export const adminOrderListQuery = z.strictObject({
  status: z.enum(ORDER_STATUSES).optional(),
  paymentStatus: z.enum(ORDER_PAYMENT_STATUSES).optional(),
  fulfilmentStatus: z.enum(FULFILMENT_STATUSES).optional(),
  returnStatus: z.enum(RETURN_STATUSES).optional(),
  method: z.enum(['RAZORPAY', 'COD']).optional(),
  exception: z.literal('1').optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** Order number, email, phone or the delivery name. */
  q: z.string().trim().min(1).max(100, 'Use at most 100 characters').optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).refine((q) => !q.from || !q.to || q.from <= q.to, { path: ['to'], message: 'Use a date on or after the start date' });

/** POST /admin/orders/:id/confirm and /deliver: email the customer about it (default yes). */
export const orderNotifyBody = z.strictObject({ notifyCustomer: z.boolean().default(true) });
/** POST /admin/orders/:id/ship (task 5.2): dispatch issues the tax invoice and consumes the stock. */
export const shipOrderBody = z.strictObject({
  courierName: z.string({ error: 'Enter the courier' }).trim().min(2, 'Enter the courier').max(80, 'Use at most 80 characters'),
  awbNumber: z.string({ error: 'Enter the AWB / tracking number' }).trim().toUpperCase()
    .regex(/^[A-Z0-9-]{4,40}$/, 'Use 4 to 40 letters, digits or dashes'),
  trackingUrl: z.string().trim().max(500, 'Use at most 500 characters').transform((v) => v || null)
    .pipe(z.url({ protocol: /^https$/, error: 'Enter a full https:// link' }).nullable()).nullable().default(null),
  weightG: z.number({ error: 'Enter the weight in grams' }).int('Use whole grams').min(1, 'Use at least 1 g').max(100_000, 'At most 100 kg').nullable().default(null),
  notifyCustomer: z.boolean().default(true),
});
export type ShipOrderInput = z.input<typeof shipOrderBody>;
/** POST /admin/orders/:id/cancel (task 5.3): staff give a reason (kept on the order and in the timeline). */
export const CANCEL_REASON_MAX = 300;
export const adminCancelOrderBody = z.strictObject({
  reason: z.string({ error: 'Say why the order is cancelled' }).trim().min(3, 'Say why the order is cancelled').max(CANCEL_REASON_MAX, `Use at most ${CANCEL_REASON_MAX} characters`),
  notifyCustomer: z.boolean().default(true),
});
/** POST /me/orders/:orderNumber/cancel: the customer's reason is optional. */
export const customerCancelOrderBody = z.strictObject({
  reason: z.string().trim().max(CANCEL_REASON_MAX, `Use at most ${CANCEL_REASON_MAX} characters`).transform((v) => v || null).nullable().default(null),
});
/** POST /admin/orders/:id/pack and /out-for-delivery. */
export const orderEmptyBody = z.strictObject({});

/** A corrected delivery address (only before packing). The shipping charge already paid does not change. */
export const orderAddressBody = addressBody.omit({ isDefault: true, label: true });
export const ADMIN_NOTE_MAX = 2000;
/** The staff note: empty clears it. */
export const adminNoteField = z.string().trim().max(ADMIN_NOTE_MAX, `Use at most ${ADMIN_NOTE_MAX.toLocaleString('en-IN')} characters`).transform((v) => v || null).nullable();
/** PATCH /admin/orders/:id: the delivery address and/or the staff note, with the version the editor saw. */
export const orderPatchBody = z.strictObject({
  version: z.number().int().positive(),
  shippingAddress: orderAddressBody.optional(),
  adminNote: adminNoteField.optional(),
}).refine((b) => b.shippingAddress !== undefined || b.adminNote !== undefined, { message: 'Nothing to change' });
export type OrderPatchInput = z.input<typeof orderPatchBody>;

/** Customer emails an admin can send again (POST /admin/orders/:id/resend-email). */
export const RESENDABLE_EMAILS = ['order_placed', 'order_confirmed', 'order_shipped', 'order_delivered'] as const;
export type ResendableEmail = (typeof RESENDABLE_EMAILS)[number];
export const resendEmailBody = z.strictObject({ template: z.enum(RESENDABLE_EMAILS, { error: 'Choose an email' }) });

/** What staff can do to the order now (the server checks again). */
export type OrderAction = 'confirm' | 'pack' | 'ship' | 'out-for-delivery' | 'deliver' | 'edit-address' | 'cancel';

export type AdminOrderRow = {
  id: number; orderNumber: string; createdAt: string; placedAt: string | null;
  customer: { name: string; email: string; phone: string; city: string; pincode: string; isGuest: boolean };
  itemCount: number; total: number; paymentMethod: 'RAZORPAY' | 'COD';
  status: OrderStatusValue; paymentStatus: OrderPaymentStatusValue; fulfilmentStatus: FulfilmentStatusValue; returnStatus: ReturnStatusValue;
  hasOpenException: boolean;
};

export type AdminOrderDetail = AdminOrderRow & {
  version: number;
  /** Contact details are masked for staff without customers:write. */
  contactMasked: boolean;
  contactEmailVerified: boolean;
  userId: number | null;
  shippingAddress: { fullName: string; phone: string; line1: string; line2: string | null; landmark: string | null; city: string; state: string; stateId: number | null; pincode: string };
  billing: { sameAsShipping: boolean; address: Record<string, unknown> | null; gstin: string | null; businessName: string | null };
  items: { id: number; productId: number | null; variantId: number | null; name: string; label: string; sku: string; imageUrl: string | null; unitPrice: number; quantity: number; lineTotal: number; discount: number; netAmount: number; taxRate: number; taxAmount: number; refundedQty: number; returnedQty: number }[];
  totals: { subtotal: number; mrpTotal: number; couponDiscount: number; couponCode: string | null; shippingFee: number; codFee: number; total: number; taxTotal: number; capturedAmount: number; refundedAmount: number };
  weights: { actualG: number; chargeableG: number };
  notes: { customer: string | null; admin: string | null };
  times: { expiresAt: string | null; confirmedAt: string | null; completedAt: string | null; cancelledAt: string | null; expiredAt: string | null; cancelReason: string | null };
  attempts: { id: number; receipt: string; providerOrderId: string | null; amount: number; status: string; createdAt: string }[];
  payments: { id: number; providerPaymentId: string; method: string | null; amount: number; status: string; allocation: string | null; amountRefunded: number; capturedAt: string | null; createdAt: string }[];
  refunds: { id: number; kind: string; method: string; status: string; amount: number; reason: string | null; createdAt: string; processedAt: string | null }[];
  exceptions: { id: number; type: string; status: string; amount: number | null; createdAt: string; resolvedAt: string | null }[];
  shipment: { courierName: string; awbNumber: string; trackingUrl: string | null; status: string; weightG: number | null; shippedAt: string | null; deliveredAt: string | null } | null;
  invoices: { id: number; kind: string; number: string; issuedAt: string; grandTotal: number }[];
  history: { dimension: string; from: string | null; to: string; note: string | null; actor: string; actorName: string | null; at: string }[];
  emails: { id: number; template: string; subject: string; to: string; status: string; at: string }[];
  actions: OrderAction[];
  /** Templates that can be sent again now. */
  resendable: ResendableEmail[];
};
