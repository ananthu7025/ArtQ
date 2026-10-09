// Customer and guest order access (task 5.7; api.md §3.5–3.6, architecture.md §5.6, product.md §5.10 and §8.5).
// Shared by the API and the storefront (validation rule). Money in paise.
import { z } from 'zod';
import { emailField as email, otpCodeField } from './auth-schemas.js';

export const customerOrderListQuery = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
/** GET /orders/track/:orderNumber?token= (the link in the order emails). */
export const trackQuery = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/, 'Invalid tracking link') });
/** POST /orders/:orderNumber/access/request: a code to the order's email (always answers `{sent: true}`). */
export const orderAccessRequestBody = z.strictObject({ email });
/** POST /orders/:orderNumber/access/verify. */
export const orderAccessVerifyBody = z.strictObject({
  email,
  code: otpCodeField,
});
export type OrderAccessVerifyInput = z.input<typeof orderAccessVerifyBody>;

/** The one label a customer sees (product.md §8.5). */
export function customerDisplayStatus(o: { status: string; paymentStatus: string; fulfilmentStatus: string; returnStatus: string }): string {
  if (o.status === 'PENDING_PAYMENT') return o.paymentStatus === 'PROCESSING' ? 'Payment processing' : 'Awaiting payment';
  if (o.status === 'EXPIRED') return 'Payment not completed';
  if (o.paymentStatus === 'REFUNDED') return 'Refunded';
  if (o.status === 'CANCELLED') return 'Cancelled';
  if (o.returnStatus === 'OPEN') return 'Return in progress';
  if (o.paymentStatus === 'PARTIALLY_REFUNDED') return 'Partially refunded';
  const f: Record<string, string> = { PACKED: 'Packed', SHIPPED: 'Shipped', OUT_FOR_DELIVERY: 'Out for delivery', DELIVERED: 'Delivered', RTO_IN_TRANSIT: 'Returning to us', RTO_RECEIVED: 'Returned to us', LOST: 'Delayed: we’re on it' };
  if (f[o.fulfilmentStatus]) return f[o.fulfilmentStatus]!;
  return o.status === 'CONFIRMED' || o.status === 'COMPLETED' ? 'Confirmed' : 'Order placed';
}

export type CustomerOrderSummary = {
  orderNumber: string; createdAt: string; displayStatus: string; total: number; itemCount: number;
  firstItem: { name: string; imageUrl: string | null } | null;
};

/**
 * One order as its customer sees it. `access`: `owner` (signed in), `guest` (email verified for this order, 1 hour) or
 * `tracking` (the emailed link: read-only, address masked, no actions, no photos).
 */
export type CustomerOrderView = {
  access: 'owner' | 'guest' | 'tracking';
  orderNumber: string; createdAt: string; placedAt: string | null; displayStatus: string;
  status: string; paymentStatus: string; fulfilmentStatus: string; returnStatus: string;
  paymentMethod: 'RAZORPAY' | 'COD';
  items: { id: number; name: string; label: string; imageUrl: string | null; unitPrice: number; quantity: number; lineTotal: number; returnableQty: number }[];
  totals: { subtotal: number; couponDiscount: number; couponCode: string | null; shipping: number; codFee: number; total: number; refunded: number };
  shippingAddress: { name: string; lines: string[]; phone: string };
  shipment: { courierName: string; awbNumber: string; trackingUrl: string | null; shippedAt: string | null; deliveredAt: string | null } | null;
  timeline: { label: string; at: string }[];
  refunds: { amount: number; status: string; createdAt: string; processedAt: string | null }[];
  returns: { id: number; status: string; reason: string; createdAt: string; note: string | null; items: { orderItemId: number; name: string; quantity: number }[]; photos: { id: number; url: string }[] }[];
  /** Until when a problem can be reported (delivery + the return window); null when not delivered. */
  returnDeadline: string | null;
  actions: { canCancel: boolean; canRetryPayment: boolean; canRequestReturn: boolean; canDownloadInvoice: boolean };
};
