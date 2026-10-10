// Coupon checks (task 4.3, product.md §8.4). Order: exists & active → time window → total capacity → per-customer limit
// (account, or the guest's email once known; best-effort for guests) → first order only → minimum order (eligible
// items) → scope. The first five need the database and live here; the last two are the pricing engine's (priceCart),
// which only sees eligible lines. A check passed here is advisory: capacity is taken atomically at checkout by
// aq_reserve_coupon, which repeats the active/window/capacity/per-customer checks under the coupon's lock.
import { couponSummary, formatINR, type PricingCoupon } from '@artq/shared';
import { Prisma, type Coupon, type PrismaClient } from '@prisma/client';

export type CouponProblem = 'COUPON_INVALID' | 'COUPON_EXPIRED' | 'COUPON_USAGE_EXCEEDED' | 'COUPON_NOT_ELIGIBLE' | 'COUPON_MIN_ORDER';
export type CouponCheck = { ok: true } | { ok: false; code: CouponProblem; message: string };
export type CouponWithTargets = Coupon & { targets: { targetType: string; targetId: number }[] };
/** Who is asking: the account, or a guest's email (checkout); both null for a guest cart before checkout. */
export type CouponCustomer = { userId: number | null; email: string | null };

const fail = (code: CouponProblem, message: string): CouponCheck => ({ ok: false, code, message });
/** Orders that count as a customer's earlier order for "first order only" (an expired or cancelled one does not). */
const COUNTED_ORDER = Prisma.sql`status IN ('PLACED','CONFIRMED','COMPLETED')`;

export const couponMessage = {
  invalid: 'This coupon code is not valid',
  notStarted: 'This coupon is not active yet',
  expired: 'This coupon has expired',
  usedUp: 'This coupon has been fully used',
  usedByYou: 'You have already used this coupon',
  firstOrder: 'This coupon is only for your first order',
  scope: 'This coupon does not apply to the items in your cart',
  empty: 'Add something to your cart to use a coupon',
  minOrder: (shortBy: number) => `Add ${formatINR(shortBy)} more of eligible items to use this coupon`,
};

export class CouponService {
  constructor(private readonly prisma: PrismaClient) {}

  /** A live (not deleted) coupon by code (citext: case-insensitive); null when none. */
  findByCode(code: string): Promise<CouponWithTargets | null> {
    return this.prisma.coupon.findFirst({ where: { code: code.trim(), deletedAt: null }, include: { targets: true } });
  }

  findById(id: number): Promise<CouponWithTargets | null> {
    return this.prisma.coupon.findFirst({ where: { id, deletedAt: null }, include: { targets: true } });
  }

  /** The database-side checks, in the product order. */
  async check(c: CouponWithTargets, who: CouponCustomer, now = new Date()): Promise<CouponCheck> {
    if (!c.isActive || c.deletedAt) return fail('COUPON_INVALID', couponMessage.invalid);
    if (c.startsAt && c.startsAt > now) return fail('COUPON_INVALID', couponMessage.notStarted);
    if (c.endsAt && c.endsAt <= now) return fail('COUPON_EXPIRED', couponMessage.expired);
    if (c.usageLimitTotal !== null && c.reservedCount + c.redeemedCount >= c.usageLimitTotal) return fail('COUPON_USAGE_EXCEEDED', couponMessage.usedUp);
    const email = who.email?.trim() || null;
    if (c.usageLimitPerCustomer !== null && (who.userId !== null || email)) {
      const [r] = await this.prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM coupon_redemptions
         WHERE coupon_id = ${c.id} AND status IN ('RESERVED','REDEEMED') AND NOT over_limit
           AND ((${who.userId}::int IS NOT NULL AND user_id = ${who.userId}::int) OR (${email}::text IS NOT NULL AND customer_email = ${email}::citext))`;
      if (r!.n >= c.usageLimitPerCustomer) return fail('COUPON_USAGE_EXCEEDED', couponMessage.usedByYou);
    }
    if (c.firstOrderOnly && (who.userId !== null || email)) {
      const [r] = await this.prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM orders
         WHERE ${COUNTED_ORDER} AND ((${who.userId}::int IS NOT NULL AND user_id = ${who.userId}::int) OR (${email}::text IS NOT NULL AND contact_email = ${email}::citext))`;
      if (r!.n > 0) return fail('COUPON_NOT_ELIGIBLE', couponMessage.firstOrder);
    }
    return { ok: true };
  }

  /** Public coupons a customer may see (active, in their window, not used up), newest first. */
  listPublic(now = new Date()): Promise<CouponWithTargets[]> {
    return this.prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM coupons WHERE is_public AND is_active AND deleted_at IS NULL
         AND (starts_at IS NULL OR starts_at <= ${now}) AND (ends_at IS NULL OR ends_at > ${now})
         AND (usage_limit_total IS NULL OR reserved_count + redeemed_count < usage_limit_total)
       ORDER BY created_at DESC, id DESC LIMIT 20`
      .then((rows) => this.prisma.coupon.findMany({ where: { id: { in: rows.map((r) => r.id) } }, include: { targets: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }));
  }
}

/** The pricing engine's view of a coupon. */
export function toPricingCoupon(c: CouponWithTargets): PricingCoupon {
  return {
    code: c.code, type: c.type, value: c.value, maxDiscount: c.maxDiscount, minOrderValue: c.minOrderValue, appliesTo: c.appliesTo,
    targetIds: c.targets.filter((t) => t.targetType === ({ TYPES: 'TYPE', CATEGORIES: 'CATEGORY', PRODUCTS: 'PRODUCT', ALL: '' } as const)[c.appliesTo]).map((t) => t.targetId),
  };
}

export const summaryOf = (c: Pick<Coupon, 'type' | 'value' | 'maxDiscount' | 'minOrderValue'>) => couponSummary(c);
