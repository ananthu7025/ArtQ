// The single authoritative shipping algorithm (architecture.md §6.5, product.md §8.2). Pure: the API loads the zone,
// slabs, settings and serviceability and calls this; nothing else computes a shipping charge.
import { assertNonNegativeInt, divCeil, type Paise } from './money.js';

export type ShippingClass = 'STANDARD' | 'BULKY' | 'SURFACE_ONLY';

export type ShippingLine = {
  quantity: number;
  /** Packed weight per unit in grams. */
  weightG: number;
  /** Outer dimensions per unit in centimetres (up to one decimal), or null. Required for BULKY. */
  dimsCm: { length: number; width: number; height: number } | null;
  shippingClass: ShippingClass;
};

export type ShippingSettings = {
  freeThreshold: Paise;          // SHIPPING.freeThreshold (₹1,000)
  packagingWeightG: number;      // SHIPPING.packagingWeightG (150)
  volumetricDivisor: number;     // SHIPPING.volumetricDivisor (5000)
  heavyCapG: number;             // SHIPPING.heavyCapG (10,000)
  heavyCapEnabled: boolean;      // SHIPPING.heavyCapEnabled
  defaultServiceable: boolean;   // SHIPPING.defaultServiceable (D-6)
  defaultCod: boolean;           // SHIPPING.defaultCod (D-6)
};

export type ShippingZone = { id: number; extraPerKg: Paise; slabs: { maxWeightG: number; rate: Paise }[] };

export type Serviceability = {
  serviceable: boolean;
  codAvailable: boolean;
  /** Whether surface transport reaches the pincode. false = air-only ⇒ SURFACE_ONLY lines cannot ship there. */
  surfaceAvailable: boolean;
};

export type ShippingInput = {
  lines: ShippingLine[];
  zone: ShippingZone;
  serviceability: Serviceability;
  subtotal: Paise;
  couponDiscount: Paise;
  freeShippingCoupon: boolean;
  settings: ShippingSettings;
};

export type ShippingQuote = {
  ok: true;
  actualWeightG: number;
  chargeableWeightG: number;
  zoneId: number;
  /** Slab rate for the chargeable weight, i.e. what an ineligible order pays. */
  rate: Paise;
  shipping: Paise;
  freeShippingApplied: boolean;
  /** Charged weight beyond the free-shipping cap (0 unless eligible and over the cap). */
  heavySurcharge: Paise;
  remainingForFree: Paise;
};
export type ShippingError = { ok: false; error: 'PINCODE_NOT_SERVICEABLE' | 'SHIPPING_RESTRICTED' | 'DIMENSIONS_REQUIRED' | 'NO_RATE' };

/** Explicit pincode row first, then the D-6 defaults (database.md §3.2). Surface availability is the caller's input. */
export function resolveServiceability(
  row: { isServiceable: boolean; codAvailable: boolean } | null,
  settings: Pick<ShippingSettings, 'defaultServiceable' | 'defaultCod'>,
  surfaceAvailable: boolean,
): Serviceability {
  return row
    ? { serviceable: row.isServiceable, codAvailable: row.isServiceable && row.codAvailable, surfaceAvailable }
    : { serviceable: settings.defaultServiceable, codAvailable: settings.defaultServiceable && settings.defaultCod, surfaceAvailable };
}

/** Volumetric grams per unit: ceil(L×W×H / divisor × 1000), exact (dims in tenths of a cm). */
export function volumetricWeightG(dimsCm: { length: number; width: number; height: number }, divisor: number): number {
  const tenths = [dimsCm.length, dimsCm.width, dimsCm.height].map((d) => {
    const t = Math.round(d * 10);
    if (!Number.isFinite(d) || d <= 0 || Math.abs(t - d * 10) > 1e-6) throw new RangeError(`dimension must be positive with at most one decimal, got ${d}`);
    return t;
  }) as [number, number, number];
  // L×W×H cm³ = (product of tenths) / 1000, so L×W×H / divisor × 1000 = product of tenths / divisor.
  return divCeil(tenths[0] * tenths[1] * tenths[2], divisor);
}

/** rate(W): first slab with maxWeightG ≥ W, else last slab rate + ceil((W − lastMax) / 1000) × extraPerKg. */
export function slabRate(weightG: number, zone: ShippingZone): Paise | null {
  if (zone.slabs.length === 0) return null;
  const slabs = [...zone.slabs].sort((a, b) => a.maxWeightG - b.maxWeightG);
  const hit = slabs.find((s) => s.maxWeightG >= weightG);
  if (hit) return hit.rate;
  const last = slabs[slabs.length - 1]!;
  return last.rate + divCeil(weightG - last.maxWeightG, 1000) * zone.extraPerKg;
}

export function shippingCharge(input: ShippingInput): ShippingQuote | ShippingError {
  const { lines, zone, serviceability, settings } = input;
  if (lines.length === 0) throw new RangeError('shippingCharge needs at least one line');
  for (const [i, l] of lines.entries()) {
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 1) throw new RangeError(`lines[${i}].quantity must be a positive integer`);
    assertNonNegativeInt(l.weightG, `lines[${i}].weightG`);
  }
  assertNonNegativeInt(input.subtotal, 'subtotal');
  assertNonNegativeInt(input.couponDiscount, 'couponDiscount');
  if (input.couponDiscount > input.subtotal) throw new RangeError('couponDiscount cannot exceed subtotal');

  // 1. Serviceability
  if (!serviceability.serviceable) return { ok: false, error: 'PINCODE_NOT_SERVICEABLE' };
  if (!serviceability.surfaceAvailable && lines.some((l) => l.shippingClass === 'SURFACE_ONLY')) return { ok: false, error: 'SHIPPING_RESTRICTED' };

  // 2–3. Chargeable weight
  let actual = 0;
  let chargeable = 0;
  for (const l of lines) {
    if (l.shippingClass === 'BULKY' && !l.dimsCm) return { ok: false, error: 'DIMENSIONS_REQUIRED' };
    const volumetric = l.dimsCm ? volumetricWeightG(l.dimsCm, settings.volumetricDivisor) : 0;
    actual += l.weightG * l.quantity;
    chargeable += Math.max(l.weightG, volumetric) * l.quantity;
  }
  actual += settings.packagingWeightG;
  chargeable += settings.packagingWeightG;

  // 4. Zone rate
  const rate = slabRate(chargeable, zone);
  if (rate === null) return { ok: false, error: 'NO_RATE' };

  // 5–6. Free shipping and the heavy cap
  const afterCoupon = input.subtotal - input.couponDiscount;
  const eligible = afterCoupon >= settings.freeThreshold || input.freeShippingCoupon;
  const remainingForFree = eligible ? 0 : settings.freeThreshold - afterCoupon;
  let shipping: Paise;
  let heavySurcharge = 0;
  if (!eligible) shipping = rate;
  else if (!settings.heavyCapEnabled || chargeable <= settings.heavyCapG) shipping = 0;
  else shipping = heavySurcharge = divCeil(chargeable - settings.heavyCapG, 1000) * zone.extraPerKg;

  return { ok: true, actualWeightG: actual, chargeableWeightG: chargeable, zoneId: zone.id, rate, shipping, freeShippingApplied: eligible, heavySurcharge, remainingForFree };
}
