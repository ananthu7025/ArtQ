// Coupons (task 4.3, product.md §8.4, database.md §3.7). Shared by the API and the admin Coupons form (validation rule).
// Money is in paise; a PERCENT value is a whole percent. The database checks the same value rule (coupons_value_ck).
import { z } from 'zod';

export const COUPON_TYPES = ['PERCENT', 'FLAT', 'FREE_SHIPPING'] as const;
export const COUPON_SCOPES = ['ALL', 'TYPES', 'CATEGORIES', 'PRODUCTS'] as const;
export const REDEMPTION_STATUSES = ['RESERVED', 'REDEEMED', 'RELEASED', 'REVERSED'] as const;
export type CouponKind = (typeof COUPON_TYPES)[number];
export type CouponScopeKind = (typeof COUPON_SCOPES)[number];
export const COUPON_CODE_MAX = 30;
export const COUPON_TARGETS_MAX = 200;
const MONEY_MAX = 100_000_000;   // ₹10,00,000

/** A code as the customer types it: case-insensitive, stored and shown in capitals. */
export const couponCodeField = z.string({ error: 'Enter a coupon code' }).trim()
  .min(1, 'Enter a coupon code')
  .max(COUPON_CODE_MAX, `Use at most ${COUPON_CODE_MAX} characters`)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Use letters, numbers, - or _')
  .transform((c) => c.toUpperCase());

const paise = (label: string) => z.number({ error: `Enter ${label}` }).int('Use whole paise').min(0, 'Use 0 or more').max(MONEY_MAX, 'At most ₹10,00,000');
const limit = z.number({ error: 'Enter a number or leave it empty' }).int('Use a whole number').min(1, 'Use 1 or more').max(1_000_000, 'At most 10,00,000').nullable();
const when = z.iso.datetime({ offset: true, error: 'Enter a date and time' }).nullable();

/** POST /admin/coupons and PUT /admin/coupons/:id. */
export const couponBody = z.strictObject({
  code: couponCodeField.refine((c) => c.length >= 3, 'Use at least 3 characters'),
  title: z.string({ error: 'Enter a title customers will see' }).trim().min(1, 'Enter a title customers will see').max(120, 'Use at most 120 characters'),
  description: z.string().trim().max(500, 'Use at most 500 characters').transform((v) => v || null).nullable().optional(),
  type: z.enum(COUPON_TYPES, { error: 'Choose a discount type' }),
  value: z.number({ error: 'Enter the discount' }).int('Use a whole number').min(0, 'Use 0 or more').max(MONEY_MAX, 'At most ₹10,00,000'),
  maxDiscount: paise('a maximum discount').nullable().default(null),
  minOrderValue: paise('a minimum order').default(0),
  startsAt: when.default(null),
  endsAt: when.default(null),
  usageLimitTotal: limit.default(null),
  usageLimitPerCustomer: limit.default(1),
  firstOrderOnly: z.boolean().default(false),
  isPublic: z.boolean().default(false),
  isActive: z.boolean().default(true),
  appliesTo: z.enum(COUPON_SCOPES, { error: 'Choose what the coupon applies to' }).default('ALL'),
  targetIds: z.array(z.number().int().positive()).max(COUPON_TARGETS_MAX, `At most ${COUPON_TARGETS_MAX}`).default([]),
}).superRefine((b, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (b.type === 'PERCENT' && (b.value < 1 || b.value > 100)) issue('value', 'Use a percentage from 1 to 100');
  if (b.type === 'FLAT' && b.value < 100) issue('value', 'Use at least ₹1');
  if (b.type === 'FREE_SHIPPING' && b.value !== 0) issue('value', 'Free shipping has no discount value');
  if (b.type !== 'PERCENT' && b.maxDiscount !== null) issue('maxDiscount', 'Only a percentage discount has a maximum');
  if (b.maxDiscount !== null && b.maxDiscount < 100) issue('maxDiscount', 'Use at least ₹1');
  if (b.startsAt && b.endsAt && Date.parse(b.endsAt) <= Date.parse(b.startsAt)) issue('endsAt', 'End after the start');
  if (b.appliesTo === 'ALL' && b.targetIds.length) issue('targetIds', 'Remove the items, or choose what the coupon applies to');
  if (b.appliesTo !== 'ALL' && b.targetIds.length === 0) issue('targetIds', 'Choose at least one');
  if (new Set(b.targetIds).size !== b.targetIds.length) issue('targetIds', 'Each item only once');
});
export type CouponInput = z.input<typeof couponBody>;
export type CouponData = z.output<typeof couponBody>;

/** GET /admin/coupons query. */
export const COUPON_STATES = ['active', 'scheduled', 'expired', 'inactive'] as const;
export const couponListQuery = z.strictObject({
  q: z.string().trim().max(60).optional(),
  state: z.enum(COUPON_STATES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** POST /cart/coupon. */
export const cartCouponBody = z.strictObject({ code: couponCodeField });

export type CouponState = (typeof COUPON_STATES)[number];
export type CouponTargetView = { id: number; name: string };
/** Admin list row and detail. */
export type CouponAdminView = {
  id: number; code: string; title: string; description: string | null; type: CouponKind; value: number; maxDiscount: number | null; minOrderValue: number;
  startsAt: string | null; endsAt: string | null; usageLimitTotal: number | null; usageLimitPerCustomer: number | null;
  reservedCount: number; redeemedCount: number; firstOrderOnly: boolean; isPublic: boolean; isActive: boolean;
  appliesTo: CouponScopeKind; targets: CouponTargetView[]; state: CouponState; hasRedemptions: boolean; updatedAt: string;
};
export type RedemptionView = {
  id: number; status: (typeof REDEMPTION_STATUSES)[number]; overLimit: boolean; discount: number; orderNumber: string;
  customer: { userId: number | null; email: string }; reservedAt: string; redeemedAt: string | null; releasedAt: string | null; reversedAt: string | null;
};
/** GET /cart/coupons: public coupons with whether this cart qualifies now. */
export type PublicCoupon = {
  code: string; title: string; description: string | null; type: CouponKind; value: number; maxDiscount: number | null; minOrderValue: number;
  endsAt: string | null; eligible: boolean; reason: string | null;
};

/** The customer-facing line for a coupon ("10% off, up to ₹200", "₹150 off", "Free shipping"). */
export function couponSummary(c: { type: CouponKind; value: number; maxDiscount: number | null; minOrderValue: number }): string {
  const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  const main = c.type === 'PERCENT' ? `${c.value}% off${c.maxDiscount ? `, up to ${rupees(c.maxDiscount)}` : ''}` : c.type === 'FLAT' ? `${rupees(c.value)} off` : 'Free shipping';
  return c.minOrderValue > 0 ? `${main} on orders of ${rupees(c.minOrderValue)} or more` : main;
}
