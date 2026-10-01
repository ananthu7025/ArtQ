import { describe, expect, it } from 'vitest';
import { codAvailability, freeShippingRemaining, priceCart, unitRefundAmounts, type PricingCoupon, type PricingInput, type PricingVariant } from './pricing.js';
import type { ShippingZone } from './shipping.js';

const KERALA: ShippingZone = { id: 1, extraPerKg: 4000, slabs: [{ maxWeightG: 500, rate: 5000 }, { maxWeightG: 1000, rate: 7000 }, { maxWeightG: 2000, rate: 11_000 }, { maxWeightG: 5000, rate: 22_000 }] };
const SERVICEABLE = { serviceable: true, codAvailable: true, surfaceAvailable: true };
const KERALA_DEST = { gstStateCode: '32', zone: KERALA, serviceability: SERVICEABLE };
const KARNATAKA_DEST = { gstStateCode: '29', zone: { ...KERALA, id: 2 }, serviceability: SERVICEABLE };
const SETTINGS: PricingInput['settings'] = {
  shipping: { freeThreshold: 100_000, packagingWeightG: 150, volumetricDivisor: 5000, heavyCapG: 10_000, heavyCapEnabled: true, defaultServiceable: true, defaultCod: true },
  payment: { codEnabled: true, codFee: 4000, codMin: 20_000, codMax: 500_000 },
};

const variant = (variantId: number, o: Partial<PricingVariant> = {}): PricingVariant => ({
  variantId, productId: variantId * 10, typeId: 1, categoryId: 11, sellable: true, price: 44_900, mrp: 59_900, gstRate: 18,
  available: 10, weightG: 300, dimsCm: null, shippingClass: 'STANDARD', ...o,
});
// Resin ₹449 (MRP ₹599), gel pigment ₹90 (MRP ₹120, other category), teak frame ₹850 (no MRP, other type)
const RESIN = variant(1);
const PIGMENT = variant(2, { price: 9000, mrp: 12_000, categoryId: 12, weightG: 50 });
const FRAME = variant(3, { price: 85_000, mrp: null, typeId: 2, categoryId: 21, weightG: 900 });
const ALL = [RESIN, PIGMENT, FRAME];

const cart = (o: Partial<PricingInput> = {}) => priceCart({
  lines: [{ variantId: 1, quantity: 1 }, { variantId: 2, quantity: 2 }], variants: ALL, coupon: null, destination: KERALA_DEST,
  paymentMethod: 'RAZORPAY', settings: SETTINGS, ...o,
});
const coupon = (o: Partial<PricingCoupon>): PricingCoupon => ({ code: 'SAVE', type: 'PERCENT', value: 10, maxDiscount: null, minOrderValue: 0, appliesTo: 'ALL', targetIds: [], ...o });

describe('priceCart: happy path', () => {
  it('prices lines, MRP savings, shipping, tax (intra-state) and total', () => {
    const r = cart();
    expect(r).toMatchObject({ subtotal: 62_900, mrpTotal: 83_900, mrpDiscount: 21_000, couponDiscount: 0, codFee: 0, blocking: [], warnings: [] });
    // W = 300 + 2×50 + 150 = 550 g ⇒ ₹70; below ₹1,000 ⇒ charged
    expect(r.shipping).toMatchObject({ ok: true, chargeableWeightG: 550, shipping: 7000, freeShippingApplied: false, remainingForFree: 37_100 });
    expect(r.total).toBe(62_900 + 7000);
    expect(r.lines[0]).toMatchObject({ lineTotal: 44_900, net: 44_900, error: null, tax: { taxable: 38_051, tax: 6849, cgst: 3424, sgst: 3425, igst: 0 } });
    expect(r.savings).toBe(21_000);
  });

  it('inter-state destination charges IGST only', () => {
    const r = cart({ destination: KARNATAKA_DEST });
    expect(r.lines[0]!.tax).toMatchObject({ cgst: 0, sgst: 0, igst: 6849 });
  });

  it('a variant without MRP counts its price as MRP', () => {
    const r = cart({ lines: [{ variantId: 3, quantity: 1 }] });
    expect(r).toMatchObject({ subtotal: 85_000, mrpTotal: 85_000, mrpDiscount: 0 });
  });

  it('reaching ₹1,000 makes shipping free; the waived rate counts as savings', () => {
    const r = cart({ lines: [{ variantId: 3, quantity: 1 }, { variantId: 2, quantity: 2 }] });   // 85,000 + 18,000
    expect(r.shipping).toMatchObject({ ok: true, shipping: 0, freeShippingApplied: true, rate: 11_000 });
    expect(r.total).toBe(103_000);
    expect(r.savings).toBe(6000 + 11_000);
  });
});

describe('priceCart: coupons', () => {
  it('PERCENT: 10 % of the eligible subtotal, allocated pro rata so line discounts sum to the total', () => {
    const r = cart({ coupon: coupon({}) });
    expect(r.coupon).toEqual({ applied: true, code: 'SAVE', type: 'PERCENT', discount: 6290, freeShipping: false });
    expect(r.lines.map((l) => l.couponDiscount)).toEqual([4490, 1800]);
    expect(r.lines.map((l) => l.net)).toEqual([40_410, 16_200]);
    expect(r.total).toBe(62_900 - 6290 + 7000);
    expect(r.lines[0]!.tax).toMatchObject({ taxable: 34_246, tax: 6164 });    // tax on the discounted net
  });

  it('PERCENT is capped by maxDiscount; percentage is floored to the paise', () => {
    expect(cart({ coupon: coupon({ maxDiscount: 5000 }) }).couponDiscount).toBe(5000);
    expect(cart({ lines: [{ variantId: 2, quantity: 1 }], variants: [{ ...PIGMENT, price: 9_999 }], coupon: coupon({ value: 15 }) }).couponDiscount).toBe(1499);   // 1499.85
  });

  it('FLAT larger than the eligible subtotal is limited to it', () => {
    const r = cart({ lines: [{ variantId: 2, quantity: 1 }], coupon: coupon({ type: 'FLAT', value: 50_000 }) });
    expect(r.couponDiscount).toBe(9000);
    expect(r.lines[0]!.net).toBe(0);
  });

  it('scope CATEGORIES discounts only lines in the target categories', () => {
    const r = cart({ coupon: coupon({ appliesTo: 'CATEGORIES', targetIds: [12] }) });
    expect(r.lines.map((l) => l.couponDiscount)).toEqual([0, 1800]);
  });

  it.each([
    ['TYPES', [2], [0, 0, 8500]],
    ['PRODUCTS', [10], [4490, 0, 0]],
    ['ALL', [], [4490, 1800, 8500]],
  ] as const)('scope %s %j', (appliesTo, targetIds, expected) => {
    const r = cart({ lines: [{ variantId: 1, quantity: 1 }, { variantId: 2, quantity: 2 }, { variantId: 3, quantity: 1 }], coupon: coupon({ appliesTo, targetIds: [...targetIds] }) });
    expect(r.lines.map((l) => l.couponDiscount)).toEqual(expected);
  });

  it('no eligible line ⇒ COUPON_NOT_ELIGIBLE, nothing discounted', () => {
    const r = cart({ coupon: coupon({ appliesTo: 'PRODUCTS', targetIds: [999] }) });
    expect(r.coupon).toEqual({ applied: false, code: 'SAVE', error: 'COUPON_NOT_ELIGIBLE', shortBy: 0 });
    expect(r.couponDiscount).toBe(0);
    expect(r.warnings).toContain('COUPON_NOT_ELIGIBLE');
  });

  it('minimum order counts eligible items only', () => {
    const below = cart({ coupon: coupon({ minOrderValue: 20_000, appliesTo: 'CATEGORIES', targetIds: [12] }) });
    expect(below.coupon).toEqual({ applied: false, code: 'SAVE', error: 'COUPON_MIN_ORDER', shortBy: 2000 });
    const exact = cart({ coupon: coupon({ minOrderValue: 18_000, appliesTo: 'CATEGORIES', targetIds: [12] }) });
    expect(exact.coupon).toMatchObject({ applied: true, discount: 1800 });
  });

  it('a coupon that pushes the order below ₹1,000 brings shipping back', () => {
    const lines = [{ variantId: 3, quantity: 1 }, { variantId: 2, quantity: 2 }];      // 103,000
    expect(cart({ lines }).shipping).toMatchObject({ shipping: 0 });
    const r = cart({ lines, coupon: coupon({ type: 'FLAT', value: 3001 }) });            // 99,999 after coupon
    expect(r.shipping).toMatchObject({ ok: true, shipping: 11_000, freeShippingApplied: false, remainingForFree: 1 });
    expect(r.total).toBe(103_000 - 3001 + 11_000);
  });

  it('FREE_SHIPPING coupon: no money discount, shipping waived', () => {
    const r = cart({ coupon: coupon({ type: 'FREE_SHIPPING', value: 0 }) });
    expect(r.coupon).toMatchObject({ applied: true, discount: 0, freeShipping: true });
    expect(r.shipping).toMatchObject({ shipping: 0, freeShippingApplied: true });
    expect(r.total).toBe(62_900);
    expect(r.savings).toBe(21_000 + 7000);
  });

  it.each([0, 101, 12.5])('rejects PERCENT value %s', (value) => {
    expect(() => cart({ coupon: coupon({ value }) })).toThrow(/PERCENT/);
  });
});

describe('priceCart: COD', () => {
  it('COD fee is added and never waived by free shipping', () => {
    const r = cart({ lines: [{ variantId: 3, quantity: 2 }], paymentMethod: 'COD' });
    expect(r.shipping).toMatchObject({ shipping: 0, freeShippingApplied: true });
    expect(r.codFee).toBe(4000);
    expect(r.total).toBe(170_000 + 4000);
    expect(r.cod).toEqual({ available: true });
    expect(r.blocking).toEqual([]);
  });

  it('COD fee is not added for online payment, but availability is still reported', () => {
    const r = cart({ paymentMethod: 'RAZORPAY' });
    expect(r.codFee).toBe(0);
    expect(r.cod).toEqual({ available: true });
  });

  it.each([
    ['COD disabled', { codEnabled: false }, SERVICEABLE, 'COD_DISABLED'],
    ['pincode without COD', {}, { ...SERVICEABLE, codAvailable: false }, 'PINCODE_NO_COD'],
    ['total above ₹5,000', { codMax: 60_000 }, SERVICEABLE, 'ABOVE_MAX'],
    ['total below ₹200', { codMin: 80_000 }, SERVICEABLE, 'BELOW_MIN'],
  ] as const)('%s ⇒ COD unavailable and a COD checkout is blocked', (_d, payment, serviceability, reason) => {
    const r = cart({ paymentMethod: 'COD', settings: { ...SETTINGS, payment: { ...SETTINGS.payment, ...payment } }, destination: { ...KERALA_DEST, serviceability } });
    expect(r.cod).toEqual({ available: false, reason });
    expect(r.blocking).toContain('COD_NOT_AVAILABLE');
  });

  it('COD limits include the fee (₹160 order + ₹40 fee reaches the ₹200 minimum)', () => {
    expect(codAvailability(20_000, SETTINGS.payment, SERVICEABLE)).toEqual({ available: true });
    expect(codAvailability(19_999, SETTINGS.payment, SERVICEABLE)).toEqual({ available: false, reason: 'BELOW_MIN' });
    expect(codAvailability(500_000, SETTINGS.payment, SERVICEABLE)).toEqual({ available: true });
    expect(codAvailability(500_001, SETTINGS.payment, SERVICEABLE)).toEqual({ available: false, reason: 'ABOVE_MAX' });
    expect(codAvailability(30_000, SETTINGS.payment, null)).toEqual({ available: false, reason: 'NO_DESTINATION' });
    const r = cart({ lines: [{ variantId: 2, quantity: 1 }], variants: [{ ...PIGMENT, price: 9000 }], paymentMethod: 'COD',
      settings: { ...SETTINGS, payment: { ...SETTINGS.payment, codMin: 9000 + 5000 + 4000 } } });   // item + ₹50 shipping + fee
    expect(r.cod).toEqual({ available: true });
  });
});

describe('priceCart: line problems', () => {
  it.each([
    ['inactive product', { variants: [RESIN, { ...PIGMENT, sellable: false }] }, 'UNAVAILABLE'],
    ['no price', { variants: [RESIN, { ...PIGMENT, price: null }] }, 'UNAVAILABLE'],
    ['no approved GST rate', { variants: [RESIN, { ...PIGMENT, gstRate: null }] }, 'UNAVAILABLE'],
    ['unknown variant', { variants: [RESIN] }, 'UNAVAILABLE'],
    ['more than available', { variants: [RESIN, { ...PIGMENT, available: 1 }] }, 'INSUFFICIENT_STOCK'],
    ['zero quantity', { lines: [{ variantId: 1, quantity: 1 }, { variantId: 2, quantity: 0 }] }, 'INVALID_QUANTITY'],
    ['quantity over 50', { lines: [{ variantId: 1, quantity: 1 }, { variantId: 2, quantity: 51 }], variants: [RESIN, { ...PIGMENT, available: 100 }] }, 'INVALID_QUANTITY'],
    ['fractional quantity', { lines: [{ variantId: 1, quantity: 1 }, { variantId: 2, quantity: 1.5 }] }, 'INVALID_QUANTITY'],
  ] as const)('%s ⇒ %s, excluded from totals and blocking checkout', (_d, o, error) => {
    const r = cart(o as unknown as Partial<PricingInput>);
    expect(r.lines[1]).toMatchObject({ variantId: 2, error, lineTotal: 0, couponDiscount: 0, tax: null });
    expect(r.subtotal).toBe(44_900);
    expect(r.blocking).toEqual([`${error}:2`]);
    expect(r.warnings).toEqual([`${error}:2`]);
  });

  it('quantity exactly equal to available and exactly 50 are fine', () => {
    expect(cart({ variants: [RESIN, { ...PIGMENT, available: 2 }] }).blocking).toEqual([]);
    expect(cart({ lines: [{ variantId: 2, quantity: 50 }], variants: [{ ...PIGMENT, available: 50 }] }).blocking).toEqual([]);
  });

  it('no usable line ⇒ CART_EMPTY: no coupon, no shipping, zero total', () => {
    const r = cart({ lines: [{ variantId: 2, quantity: 1 }], variants: [{ ...PIGMENT, sellable: false }], coupon: coupon({}) });
    expect(r).toMatchObject({ subtotal: 0, total: 0, coupon: null, shipping: null });
    expect(r.blocking).toEqual(['UNAVAILABLE:2', 'CART_EMPTY']);
    expect(cart({ lines: [] }).blocking).toEqual(['CART_EMPTY']);
  });

  it('duplicate lines for one variant are a programming error', () => {
    expect(() => cart({ lines: [{ variantId: 1, quantity: 1 }, { variantId: 1, quantity: 2 }] })).toThrow(/duplicate/);
  });
});

describe('priceCart: destination', () => {
  it('no destination yet ⇒ shipping null, tax split unknown, checkout blocked', () => {
    const r = cart({ destination: null });
    expect(r.shipping).toBeNull();
    expect(r.total).toBe(62_900);
    expect(r.lines[0]!.tax).toMatchObject({ tax: 6849, cgst: null, igst: null });
    expect(r.blocking).toEqual(['DESTINATION_REQUIRED']);
    expect(r.cod).toEqual({ available: false, reason: 'NO_DESTINATION' });
  });

  it('non-serviceable pincode ⇒ shipping error, total without shipping, checkout blocked', () => {
    const r = cart({ destination: { ...KERALA_DEST, serviceability: { serviceable: false, codAvailable: false, surfaceAvailable: true } } });
    expect(r.shipping).toEqual({ ok: false, error: 'PINCODE_NOT_SERVICEABLE' });
    expect(r.total).toBe(62_900);
    expect(r.blocking).toEqual(['PINCODE_NOT_SERVICEABLE']);
  });

  it('resin (SURFACE_ONLY) to an air-only pincode ⇒ SHIPPING_RESTRICTED', () => {
    const r = cart({ variants: [{ ...RESIN, shippingClass: 'SURFACE_ONLY' }, PIGMENT], destination: { ...KERALA_DEST, serviceability: { ...SERVICEABLE, surfaceAvailable: false } } });
    expect(r.blocking).toEqual(['SHIPPING_RESTRICTED']);
  });
});

describe('helpers', () => {
  it.each([[90_000, 0, 100_000, 10_000], [100_000, 0, 100_000, 0], [120_000, 30_000, 100_000, 10_000], [200_000, 0, 100_000, 0]])(
    'freeShippingRemaining(%i, %i, %i) = %i', (s, c, t, r) => { expect(freeShippingRemaining(s, c, t)).toBe(r); });

  it.each([[1000, 3, [333, 333, 334]], [900, 3, [300, 300, 300]], [5, 1, [5]], [1, 2, [0, 1]]])('unitRefundAmounts(%i, %i) = %j', (net, qty, units) => {
    expect(unitRefundAmounts(net, qty)).toEqual(units);
  });
  it('unitRefundAmounts rejects bad input', () => {
    expect(() => unitRefundAmounts(100, 0)).toThrow(/quantity/);
    expect(() => unitRefundAmounts(-1, 1)).toThrow(/net/);
  });
});
