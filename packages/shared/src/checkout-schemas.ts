// Checkout (product.md §5.6, api.md §3.8; tasks 4.6–4.8). Shared by the API and the checkout page (validation rule).
// Money in paise.
import { z } from 'zod';
import { addressBody, emailField } from './auth-schemas.js';
import type { CartView } from './storefront-schemas.js';
import { pincodeField } from './storefront-schemas.js';

export const PAYMENT_METHODS = ['RAZORPAY', 'COD'] as const;
export type CheckoutPaymentMethod = (typeof PAYMENT_METHODS)[number];

/** An Indian mobile (10 digits starting 6–9; spaces, dashes and a +91 / 0 prefix allowed) → `+91XXXXXXXXXX`. */
export const indianMobileField = z.string({ error: 'Enter a 10-digit mobile number' })
  .transform((v) => v.replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, ''))
  .pipe(z.string().regex(/^[6-9]\d{9}$/, 'Enter a 10-digit mobile number'))
  .transform((v) => `+91${v}`);

/** GSTIN: 2-digit state code, PAN, entity number, Z, check character. */
export const gstinField = z.string().trim().toUpperCase()
  .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Enter a 15-character GSTIN, e.g. 32ABCDE1234F1Z5');

export const checkoutContactBody = z.strictObject({
  email: emailField,
  phone: indianMobileField,
  /** Guests: email a link to set a password after the order (creates the account). */
  sendSetPasswordLink: z.boolean().default(false),
});

/** A new delivery address typed at checkout; `save` keeps it in the account (signed-in customers). */
export const checkoutAddressBody = addressBody.omit({ isDefault: true }).extend({ save: z.boolean().default(false) });
/** A billing address (never saved). */
export const billingAddressBody = addressBody.omit({ isDefault: true, label: true });

export const checkoutInitiateBody = z.strictObject({
  contact: checkoutContactBody,
  shippingAddressId: z.number().int().positive().nullable().default(null),
  shippingAddress: checkoutAddressBody.nullable().default(null),
  billingSameAsShipping: z.boolean().default(true),
  billingAddress: billingAddressBody.nullable().default(null),
  gstin: gstinField.nullable().default(null),
  businessName: z.string().trim().max(120, 'Use at most 120 characters').transform((v) => v || null).nullable().default(null),
  paymentMethod: z.enum(PAYMENT_METHODS, { error: 'Choose how to pay' }),
  customerNote: z.string().trim().max(500, 'Use at most 500 characters').transform((v) => v || null).nullable().default(null),
  /** The total the customer saw; a different server total → 409 PRICE_CHANGED. */
  expectedTotal: z.number().int().min(0),
  acceptTerms: z.literal(true, { error: 'Accept the terms to place your order' }),
  utm: z.strictObject({ source: z.string().max(100).optional(), medium: z.string().max(100).optional(), campaign: z.string().max(100).optional() }).optional(),
}).superRefine((b, ctx) => {
  if ((b.shippingAddressId === null) === (b.shippingAddress === null)) ctx.addIssue({ code: 'custom', path: ['shippingAddress'], message: 'Choose or add a delivery address' });
  if (!b.billingSameAsShipping && !b.billingAddress) ctx.addIssue({ code: 'custom', path: ['billingAddress'], message: 'Add the billing address' });
  if (b.gstin && !b.businessName) ctx.addIssue({ code: 'custom', path: ['businessName'], message: 'Enter the business name for the GST invoice' });
});
export type CheckoutInitiateInput = z.input<typeof checkoutInitiateBody>;

/** POST /checkout/quote: the cart priced for a delivery pincode (a saved address, or the pincode being typed). */
export const checkoutQuoteBody = z.strictObject({
  shippingAddressId: z.number().int().positive().optional(),
  pincode: pincodeField.optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).default('RAZORPAY'),
}).refine((b) => (b.shippingAddressId === undefined) !== (b.pincode === undefined), { message: 'Send a saved address or a pincode', path: ['pincode'] });

/** POST /orders/:orderNumber/payment/retry: pay again online, or switch the pending order to cash on delivery. */
export const paymentRetryBody = z.strictObject({ paymentMethod: z.enum(PAYMENT_METHODS) });

export type CodReason = 'COD_DISABLED' | 'PINCODE_NO_COD' | 'BELOW_MIN' | 'ABOVE_MAX' | 'NO_DESTINATION';
export type CheckoutQuote = {
  cart: CartView;
  /** Pay online is on (PAYMENT.razorpayEnabled). */
  onlineEnabled: boolean;
  cod: { available: boolean; reason: CodReason | null; fee: number; min: number; max: number };
  /** Reasons the order cannot be placed as it stands (e.g. PINCODE_NOT_SERVICEABLE, UNAVAILABLE:12, COD_NOT_AVAILABLE). */
  blocking: string[];
};

export type RazorpayCheckout = { keyId: string; orderId: string; amount: number; currency: 'INR'; name: string; prefill: { name?: string; email?: string; contact?: string } };
/** POST /checkout/initiate and POST /orders/:n/payment/retry (api.md §3.8). */
export type InitiateResult =
  | { orderNumber: string; status: 'PENDING_PAYMENT'; total: number; expiresAt: string; razorpay: RazorpayCheckout }
  | { orderNumber: string; status: 'PENDING_PAYMENT'; total: number; expiresAt: string; razorpay: null; retryPayment: true }
  | { orderNumber: string; status: 'PAYMENT_STARTING'; retryAfter: number }
  | { orderNumber: string; status: 'PLACED'; total: number };
/** POST /checkout/verify. */
export type VerifyResult = { status: 'PLACED' | 'PROCESSING' | 'REVIEW' | 'PAYMENT_REFUNDED' };
/** GET /checkout/status/:orderNumber (polled while PROCESSING). */
export type CheckoutStatus = { status: 'PENDING_PAYMENT' | 'PLACED' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED'; paymentStatus: string; displayStatus: string };

/** GET /checkout/orders/:orderNumber: the confirmation page (product.md §5.8). */
export type OrderConfirmation = {
  orderNumber: string; status: CheckoutStatus['status']; paymentStatus: string; displayStatus: string; paymentMethod: CheckoutPaymentMethod;
  firstName: string; contactEmail: string;
  items: { name: string; label: string; quantity: number; lineTotal: number; imageUrl: string | null }[];
  totals: { subtotal: number; couponDiscount: number; couponCode: string | null; shipping: number; codFee: number; total: number };
  address: { name: string; lines: string[] };
  estimatedDays: { min: number; max: number };
  /** A guest order whose email has no password yet: the page offers "Set a password". */
  canSetPassword: boolean;
};
