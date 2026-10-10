import { describe, expect, it } from 'vitest';
import { cartCouponBody, couponBody, couponSummary } from './coupon-schemas.js';

describe('couponSummary', () => {
  it.each([
    [{ type: 'PERCENT', value: 10, maxDiscount: null, minOrderValue: 0 }, '10% off'],
    [{ type: 'PERCENT', value: 15, maxDiscount: 25_050, minOrderValue: 99_900 }, '15% off, up to ₹250.5 on orders of ₹999 or more'],
    [{ type: 'FLAT', value: 15_000, maxDiscount: null, minOrderValue: 1_00_000 }, '₹150 off on orders of ₹1,000 or more'],
    [{ type: 'FREE_SHIPPING', value: 0, maxDiscount: null, minOrderValue: 0 }, 'Free shipping'],
  ] as const)('%j → %s', (c, text) => { expect(couponSummary(c)).toBe(text); });
});

describe('codes', () => {
  it('the cart takes any code shape and normalises it (trim, capitals); the admin needs 3+ characters', () => {
    expect(cartCouponBody.parse({ code: '  welcome10 ' })).toEqual({ code: 'WELCOME10' });
    expect(cartCouponBody.safeParse({ code: 'AB' }).success).toBe(true);
    for (const bad of ['', '  ', 'NEW YEAR', '-LEADING', 'A'.repeat(31)]) expect(cartCouponBody.safeParse({ code: bad }).success, bad).toBe(false);
    expect(couponBody.safeParse({ code: 'AB', title: 't', type: 'FLAT', value: 100 }).success).toBe(false);
  });
});

describe('couponBody', () => {
  it('fills the defaults (1 use per customer, every product, active, not public)', () => {
    expect(couponBody.parse({ code: 'abc', title: ' Hi ', type: 'FLAT', value: 100 })).toEqual({
      code: 'ABC', title: 'Hi', type: 'FLAT', value: 100, maxDiscount: null, minOrderValue: 0, startsAt: null, endsAt: null, usageLimitTotal: null,
      usageLimitPerCustomer: 1, firstOrderOnly: false, isPublic: false, isActive: true, appliesTo: 'ALL', targetIds: [],
    });
  });
  it('dates need an offset; the same item twice is refused', () => {
    const b = { code: 'ABC', title: 't', type: 'FLAT', value: 100 };
    expect(couponBody.safeParse({ ...b, startsAt: '2026-11-01T10:00:00' }).success).toBe(false);
    expect(couponBody.safeParse({ ...b, startsAt: '2026-11-01T10:00:00+05:30' }).success).toBe(true);
    expect(couponBody.safeParse({ ...b, appliesTo: 'PRODUCTS', targetIds: [3, 3] }).error?.issues[0]?.message).toBe('Each item only once');
  });
});
