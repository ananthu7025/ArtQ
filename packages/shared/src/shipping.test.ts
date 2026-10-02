import { describe, expect, it } from 'vitest';
import { resolveServiceability, shippingCharge, slabRate, volumetricWeightG, type ShippingInput, type ShippingLine, type ShippingSettings, type ShippingZone } from './shipping.js';

// Default rates, product.md §8.2 (paise).
const zone = (id: number, rates: [number, number, number, number], extraPerKg: number): ShippingZone => ({
  id, extraPerKg, slabs: [500, 1000, 2000, 5000].map((maxWeightG, i) => ({ maxWeightG, rate: rates[i]! })),
});
const KERALA = zone(1, [5000, 7000, 11000, 22000], 4000);
const SOUTH = zone(2, [6000, 8500, 13000, 26000], 4500);
const INDIA = zone(3, [7000, 10000, 15000, 30000], 5500);
const NE = zone(4, [10000, 14000, 20000, 40000], 7500);
const ZONES = { KERALA, SOUTH, INDIA, NE };

// SHIPPING settings defaults, database.md §3.13.
const SETTINGS: ShippingSettings = {
  freeThreshold: 100_000, packagingWeightG: 150, volumetricDivisor: 5000, heavyCapG: 10_000, heavyCapEnabled: true,
  defaultServiceable: true, defaultCod: true,
};
const line = (weightG: number, quantity = 1, extra: Partial<ShippingLine> = {}): ShippingLine => ({ quantity, weightG, dimsCm: null, shippingClass: 'STANDARD', ...extra });
const quote = (o: Partial<ShippingInput> & { lines: ShippingLine[] }) => shippingCharge({
  zone: KERALA, serviceability: { serviceable: true, codAvailable: true, surfaceAvailable: true },
  subtotal: 50_000, couponDiscount: 0, freeShippingCoupon: false, settings: SETTINGS, ...o,
});
const ok = (r: ReturnType<typeof shippingCharge>) => { if (!r.ok) throw new Error(`unexpected ${r.error}`); return r; };

describe('slab rates: every boundary of the product.md §8.2 table (W includes 150 g packaging)', () => {
  it.each([
    // zone, chargeable W, expected rate (paise)
    ['KERALA', 150, 5000], ['KERALA', 500, 5000], ['KERALA', 501, 7000], ['KERALA', 1000, 7000], ['KERALA', 1001, 11000],
    ['KERALA', 2000, 11000], ['KERALA', 2001, 22000], ['KERALA', 5000, 22000], ['KERALA', 5001, 26000], ['KERALA', 6000, 26000],
    ['KERALA', 6001, 30000],
    ['SOUTH', 500, 6000], ['SOUTH', 1000, 8500], ['SOUTH', 2000, 13000], ['SOUTH', 5000, 26000], ['SOUTH', 7150, 39500],
    ['INDIA', 500, 7000], ['INDIA', 1000, 10000], ['INDIA', 2000, 15000], ['INDIA', 5000, 30000], ['INDIA', 12150, 74000],
    ['NE', 500, 10000], ['NE', 1000, 14000], ['NE', 2000, 20000], ['NE', 5000, 40000], ['NE', 5500, 47500],
  ] as const)('%s W=%i g → %i', (z, w, rate) => {
    expect(slabRate(w, ZONES[z])).toBe(rate);
    const r = ok(quote({ zone: ZONES[z], lines: [line(w - 150)] }));
    expect(r).toMatchObject({ chargeableWeightG: w, rate, shipping: rate, freeShippingApplied: false, heavySurcharge: 0 });
  });

  it('unsorted slabs give the same result; no slabs ⇒ NO_RATE', () => {
    const shuffled = { ...KERALA, slabs: [...KERALA.slabs].reverse() };
    expect(slabRate(1500, shuffled)).toBe(11000);
    expect(slabRate(500, { ...KERALA, slabs: [] })).toBeNull();
    expect(quote({ zone: { ...KERALA, slabs: [] }, lines: [line(100)] })).toEqual({ ok: false, error: 'NO_RATE' });
  });
});

describe('architecture.md §6.5 worked example (Kerala, two 6 kg packs)', () => {
  it('eligible order over the 10 kg cap pays ₹120 for the excess', () => {
    expect(quote({ lines: [line(6000, 2)], subtotal: 1_090_000 })).toEqual({
      ok: true, actualWeightG: 12_150, chargeableWeightG: 12_150, zoneId: 1, rate: 54_000, shipping: 12_000,
      freeShippingApplied: true, heavySurcharge: 12_000, remainingForFree: 0,
    });
  });
  it('the same weight, not eligible, pays rate(W) = ₹540', () => {
    expect(ok(quote({ lines: [line(6000, 2)], subtotal: 90_000 }))).toMatchObject({ shipping: 54_000, heavySurcharge: 0, remainingForFree: 10_000 });
  });
});

describe('free-shipping eligibility', () => {
  it.each([
    // description, subtotal, couponDiscount, freeShippingCoupon, eligible, remaining
    ['₹1 below threshold', 99_999, 0, false, false, 1],
    ['exactly at threshold', 100_000, 0, false, true, 0],
    ['above threshold', 250_000, 0, false, true, 0],
    ['coupon pushes ₹1 below threshold', 120_000, 20_001, false, false, 1],
    ['coupon leaves exactly the threshold', 120_000, 20_000, false, true, 0],
    ['FREE_SHIPPING coupon on a small order', 30_000, 0, true, true, 0],
    ['FREE_SHIPPING coupon with zero subtotal after discount', 30_000, 30_000, true, true, 0],
    ['empty-value order is not eligible', 0, 0, false, false, 100_000],
  ] as const)('%s', (_d, subtotal, couponDiscount, freeShippingCoupon, eligible, remaining) => {
    const r = ok(quote({ lines: [line(850)], subtotal, couponDiscount, freeShippingCoupon }));
    expect(r.freeShippingApplied).toBe(eligible);
    expect(r.shipping).toBe(eligible ? 0 : 7000);
    expect(r.remainingForFree).toBe(remaining);
  });
});

describe('heavy cap (free shipping covers 10 kg)', () => {
  it.each([
    // description, zone, line weight, qty, heavyCapEnabled, expected shipping
    ['exactly at the cap is free', 'KERALA', 9850, 1, true, 0],
    ['1 g over the cap pays one extra kg', 'KERALA', 9851, 1, true, 4000],
    ['1 kg over the cap pays one extra kg', 'KERALA', 10_850, 1, true, 4000],
    ['1 kg + 1 g over pays two', 'KERALA', 10_851, 1, true, 8000],
    ['NE zone uses its own extra rate', 'NE', 10_000, 1, true, 7500],
    ['cap disabled ⇒ any weight is free', 'INDIA', 10_000, 2, false, 0],
  ] as const)('%s', (_d, z, w, qty, heavyCapEnabled, shipping) => {
    const r = ok(quote({ zone: ZONES[z], lines: [line(w, qty)], subtotal: 200_000, settings: { ...SETTINGS, heavyCapEnabled } }));
    expect(r.shipping).toBe(shipping);
    expect(r.heavySurcharge).toBe(shipping);
    expect(r.freeShippingApplied).toBe(true);
  });

  it('FREE_SHIPPING coupon is also subject to the cap', () => {
    expect(ok(quote({ lines: [line(6000, 2)], subtotal: 20_000, freeShippingCoupon: true })).shipping).toBe(12_000);
  });
});

describe('chargeable weight: actual vs volumetric', () => {
  it.each([
    // description, line, expected chargeable W, expected actual W, expected Kerala rate
    ['BULKY frame: volumetric 4,800 g beats actual 1,000 g', line(1000, 1, { shippingClass: 'BULKY', dimsCm: { length: 40, width: 30, height: 20 } }), 4950, 1150, 22000],
    ['actual beats volumetric', line(500, 1, { dimsCm: { length: 10.5, width: 10, height: 10 } }), 650, 650, 7000],
    ['volumetric is rounded up to the gram', line(0, 1, { dimsCm: { length: 3.3, width: 3.3, height: 3.3 } }), 158, 150, 5000],
    ['quantity multiplies the volumetric weight', line(1000, 2, { shippingClass: 'BULKY', dimsCm: { length: 40, width: 30, height: 20 } }), 9750, 2150, 42000],
    ['lines without dimensions use actual weight', line(700, 3), 2250, 2250, 22000],
  ] as const)('%s', (_d, l, chargeable, actual, rate) => {
    expect(ok(quote({ lines: [l] }))).toMatchObject({ chargeableWeightG: chargeable, actualWeightG: actual, rate, shipping: rate });
  });

  it('mixed lines add up per line', () => {
    const r = ok(quote({ lines: [line(300, 2), line(200, 1, { dimsCm: { length: 20, width: 20, height: 10 } })] }));   // 600 + 800 + 150
    expect(r.chargeableWeightG).toBe(1550);
    expect(r.actualWeightG).toBe(950);
  });

  it.each([
    [{ length: 40, width: 30, height: 20 }, 5000, 4800],
    [{ length: 3.3, width: 3.3, height: 3.3 }, 5000, 8],
    [{ length: 100, width: 100, height: 100 }, 5000, 200_000],
    [{ length: 40, width: 30, height: 20 }, 4000, 6000],
  ])('volumetricWeightG(%j, %i) = %i', (dims, divisor, grams) => {
    expect(volumetricWeightG(dims, divisor)).toBe(grams);
  });
});

describe('serviceability and restrictions', () => {
  it('non-serviceable pincode ⇒ PINCODE_NOT_SERVICEABLE (before any other check)', () => {
    expect(quote({ lines: [line(100, 1, { shippingClass: 'SURFACE_ONLY' })], serviceability: { serviceable: false, codAvailable: false, surfaceAvailable: false } }))
      .toEqual({ ok: false, error: 'PINCODE_NOT_SERVICEABLE' });
  });
  it('SURFACE_ONLY line to an air-only pincode ⇒ SHIPPING_RESTRICTED', () => {
    expect(quote({ lines: [line(100), line(900, 1, { shippingClass: 'SURFACE_ONLY' })], serviceability: { serviceable: true, codAvailable: true, surfaceAvailable: false } }))
      .toEqual({ ok: false, error: 'SHIPPING_RESTRICTED' });
  });
  it('SURFACE_ONLY line ships where surface is available; STANDARD ships to air-only pincodes', () => {
    expect(quote({ lines: [line(900, 1, { shippingClass: 'SURFACE_ONLY' })] }).ok).toBe(true);
    expect(quote({ lines: [line(900)], serviceability: { serviceable: true, codAvailable: true, surfaceAvailable: false } }).ok).toBe(true);
  });
  it('BULKY line without dimensions ⇒ DIMENSIONS_REQUIRED', () => {
    expect(quote({ lines: [line(900, 1, { shippingClass: 'BULKY' })] })).toEqual({ ok: false, error: 'DIMENSIONS_REQUIRED' });
  });

  it.each([
    ['explicit row wins', { isServiceable: true, codAvailable: false }, SETTINGS, { serviceable: true, codAvailable: false }],
    ['non-serviceable row never allows COD', { isServiceable: false, codAvailable: true }, SETTINGS, { serviceable: false, codAvailable: false }],
    ['no row ⇒ D-6 defaults', null, SETTINGS, { serviceable: true, codAvailable: true }],
    ['no row, defaults off', null, { ...SETTINGS, defaultServiceable: false }, { serviceable: false, codAvailable: false }],
    ['no row, COD default off', null, { ...SETTINGS, defaultCod: false }, { serviceable: true, codAvailable: false }],
  ] as const)('resolveServiceability: %s', (_d, row, settings, expected) => {
    expect(resolveServiceability(row, settings, true)).toEqual({ ...expected, surfaceAvailable: true });
  });
});

describe('invalid input is rejected, not priced', () => {
  it.each([
    ['no lines', { lines: [] }, /at least one line/],
    ['zero quantity', { lines: [line(100, 0)] }, /quantity/],
    ['fractional quantity', { lines: [line(100, 1.5)] }, /quantity/],
    ['negative weight', { lines: [line(-1)] }, /weightG/],
    ['fractional grams', { lines: [line(10.5)] }, /weightG/],
    ['coupon larger than subtotal', { lines: [line(100)], subtotal: 100, couponDiscount: 101 }, /couponDiscount/],
    ['negative subtotal', { lines: [line(100)], subtotal: -1 }, /subtotal/],
    ['zero dimension', { lines: [line(100, 1, { dimsCm: { length: 0, width: 1, height: 1 } })] }, /dimension/],
    ['dimension with two decimals', { lines: [line(100, 1, { dimsCm: { length: 1.25, width: 1, height: 1 } })] }, /dimension/],
  ] as const)('%s', (_d, o, re) => {
    expect(() => quote(o as unknown as Parameters<typeof quote>[0])).toThrow(re);
  });
});
