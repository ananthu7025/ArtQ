// Pricing engine (architecture.md §6.4), called only by the API. Pure: the caller loads variants, coupon, destination
// (zone + serviceability + GST state) and settings. Coupon checks that need the database (active, time window, capacity,
// per-customer limit, first order) happen in the coupon service and aq_reserve_coupon; this applies minimum order,
// scope, value and cap, and allocates the discount to lines.
import { allocateLargestRemainder, assertNonNegativeInt, type Paise } from './money.js';
import { shippingCharge, type Serviceability, type ShippingClass, type ShippingError, type ShippingQuote, type ShippingSettings, type ShippingZone } from './shipping.js';
import { isIntraState, lineTax, type LineTax } from './tax.js';

export const MAX_QUANTITY_PER_LINE = 50;

export type PricingVariant = {
  variantId: number;
  productId: number;
  typeId: number | null;
  categoryId: number | null;
  /** Product ACTIVE, variant active and not deleted. */
  sellable: boolean;
  price: Paise | null;
  mrp: Paise | null;
  gstRate: number | null;
  available: number;
  weightG: number;
  dimsCm: { length: number; width: number; height: number } | null;
  shippingClass: ShippingClass;
};

export type CouponType = 'PERCENT' | 'FLAT' | 'FREE_SHIPPING';
export type PricingCoupon = {
  code: string;
  type: CouponType;
  /** PERCENT: whole percent 1–100; FLAT: paise; FREE_SHIPPING: ignored. */
  value: number;
  maxDiscount: Paise | null;
  minOrderValue: Paise;
  appliesTo: 'ALL' | 'TYPES' | 'CATEGORIES' | 'PRODUCTS';
  targetIds: number[];
};

export type PaymentMethod = 'RAZORPAY' | 'COD';
export type PaymentSettings = { codEnabled: boolean; codFee: Paise; codMin: Paise; codMax: Paise };

export type PricingInput = {
  lines: { variantId: number; quantity: number }[];
  variants: PricingVariant[];
  coupon: PricingCoupon | null;
  destination: { gstStateCode: string; zone: ShippingZone; serviceability: Serviceability } | null;
  paymentMethod: PaymentMethod | null;
  settings: { shipping: ShippingSettings; payment: PaymentSettings };
};

export type LineError = 'UNAVAILABLE' | 'INSUFFICIENT_STOCK' | 'INVALID_QUANTITY';
export type PricedLine = {
  variantId: number;
  quantity: number;
  unitPrice: Paise | null;
  unitMrp: Paise | null;
  lineTotal: Paise;
  mrpTotal: Paise;
  couponDiscount: Paise;
  net: Paise;
  tax: LineTax | null;
  error: LineError | null;
  available: number;
};

export type CouponOutcome =
  | { applied: true; code: string; type: CouponType; discount: Paise; freeShipping: boolean }
  | { applied: false; code: string; error: 'COUPON_MIN_ORDER' | 'COUPON_NOT_ELIGIBLE'; shortBy: Paise };

export type CodAvailability = { available: true } | { available: false; reason: 'COD_DISABLED' | 'PINCODE_NO_COD' | 'BELOW_MIN' | 'ABOVE_MAX' | 'NO_DESTINATION' };

export type PricedCart = {
  lines: PricedLine[];
  subtotal: Paise;
  mrpTotal: Paise;
  mrpDiscount: Paise;
  coupon: CouponOutcome | null;
  couponDiscount: Paise;
  /** null until a destination is known; an error object when the destination cannot be served. */
  shipping: ShippingQuote | ShippingError | null;
  codFee: Paise;
  total: Paise;
  /** MRP discount + coupon discount + shipping waived. */
  savings: Paise;
  cod: CodAvailability;
  /** Reasons checkout must refuse this cart (empty ⇒ payable). */
  blocking: string[];
  warnings: string[];
};

function priceLines(input: PricingInput): PricedLine[] {
  const byId = new Map(input.variants.map((v) => [v.variantId, v]));
  const seen = new Set<number>();
  return input.lines.map((l) => {
    if (seen.has(l.variantId)) throw new RangeError(`duplicate cart line for variant ${l.variantId}`);
    seen.add(l.variantId);
    const v = byId.get(l.variantId);
    const base = { variantId: l.variantId, quantity: l.quantity, couponDiscount: 0, tax: null, available: v?.available ?? 0 };
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 1 || l.quantity > MAX_QUANTITY_PER_LINE) {
      return { ...base, unitPrice: v?.price ?? null, unitMrp: v?.mrp ?? null, lineTotal: 0, mrpTotal: 0, net: 0, error: 'INVALID_QUANTITY' };
    }
    if (!v || !v.sellable || v.price === null || v.gstRate === null) {
      return { ...base, unitPrice: v?.price ?? null, unitMrp: v?.mrp ?? null, lineTotal: 0, mrpTotal: 0, net: 0, error: 'UNAVAILABLE' };
    }
    assertNonNegativeInt(v.price, `variant ${v.variantId} price`);
    if (l.quantity > v.available) {
      return { ...base, unitPrice: v.price, unitMrp: v.mrp, lineTotal: 0, mrpTotal: 0, net: 0, error: 'INSUFFICIENT_STOCK' };
    }
    const lineTotal = v.price * l.quantity;
    const mrpTotal = Math.max(v.mrp ?? v.price, v.price) * l.quantity;
    return { ...base, unitPrice: v.price, unitMrp: v.mrp, lineTotal, mrpTotal, net: lineTotal, error: null };
  });
}

function eligibleFor(coupon: PricingCoupon, v: PricingVariant): boolean {
  switch (coupon.appliesTo) {
    case 'ALL': return true;
    case 'TYPES': return v.typeId !== null && coupon.targetIds.includes(v.typeId);
    case 'CATEGORIES': return v.categoryId !== null && coupon.targetIds.includes(v.categoryId);
    case 'PRODUCTS': return coupon.targetIds.includes(v.productId);
  }
}

/** Coupon value on the eligible lines; mutates line couponDiscount/net with the pro-rata allocation. */
function applyCoupon(coupon: PricingCoupon, lines: PricedLine[], variants: Map<number, PricingVariant>): CouponOutcome {
  if (coupon.type === 'PERCENT' && (!Number.isSafeInteger(coupon.value) || coupon.value < 1 || coupon.value > 100)) {
    throw new RangeError(`PERCENT coupon value must be 1–100, got ${coupon.value}`);
  }
  if (coupon.type === 'FLAT') assertNonNegativeInt(coupon.value, 'FLAT coupon value');
  const eligible = lines.filter((l) => l.error === null && eligibleFor(coupon, variants.get(l.variantId)!));
  const eligibleSubtotal = eligible.reduce((s, l) => s + l.lineTotal, 0);
  if (eligible.length === 0) return { applied: false, code: coupon.code, error: 'COUPON_NOT_ELIGIBLE', shortBy: 0 };
  if (eligibleSubtotal < coupon.minOrderValue) {
    return { applied: false, code: coupon.code, error: 'COUPON_MIN_ORDER', shortBy: coupon.minOrderValue - eligibleSubtotal };
  }
  let discount = 0;
  if (coupon.type === 'PERCENT') discount = Math.floor((eligibleSubtotal * coupon.value) / 100);   // never above the exact percentage
  else if (coupon.type === 'FLAT') discount = coupon.value;
  if (coupon.maxDiscount !== null) discount = Math.min(discount, coupon.maxDiscount);
  discount = Math.min(discount, eligibleSubtotal);
  const shares = allocateLargestRemainder(discount, eligible.map((l) => l.lineTotal));
  eligible.forEach((l, i) => { l.couponDiscount = shares[i]!; l.net = l.lineTotal - l.couponDiscount; });
  return { applied: true, code: coupon.code, type: coupon.type, discount, freeShipping: coupon.type === 'FREE_SHIPPING' };
}

/** COD rules (product.md §8.9): enabled, pincode allows COD, order total (including the fee) within codMin–codMax. */
export function codAvailability(total: Paise, settings: PaymentSettings, serviceability: Serviceability | null): CodAvailability {
  if (!settings.codEnabled) return { available: false, reason: 'COD_DISABLED' };
  if (!serviceability) return { available: false, reason: 'NO_DESTINATION' };
  if (!serviceability.codAvailable) return { available: false, reason: 'PINCODE_NO_COD' };
  if (total < settings.codMin) return { available: false, reason: 'BELOW_MIN' };
  if (total > settings.codMax) return { available: false, reason: 'ABOVE_MAX' };
  return { available: true };
}

export function priceCart(input: PricingInput): PricedCart {
  const variants = new Map(input.variants.map((v) => [v.variantId, v]));
  const lines = priceLines(input);
  const ok = lines.filter((l) => l.error === null);
  const warnings: string[] = [];
  const blocking: string[] = [];
  for (const l of lines) if (l.error) { warnings.push(`${l.error}:${l.variantId}`); blocking.push(`${l.error}:${l.variantId}`); }
  if (ok.length === 0) blocking.push('CART_EMPTY');

  const subtotal = ok.reduce((s, l) => s + l.lineTotal, 0);
  const mrpTotal = ok.reduce((s, l) => s + l.mrpTotal, 0);
  const mrpDiscount = mrpTotal - subtotal;

  let coupon: CouponOutcome | null = null;
  if (input.coupon && ok.length > 0) {
    coupon = applyCoupon(input.coupon, lines, variants);
    if (!coupon.applied) warnings.push(coupon.error);
  }
  const couponDiscount = coupon?.applied ? coupon.discount : 0;

  let shipping: ShippingQuote | ShippingError | null = null;
  if (input.destination && ok.length > 0) {
    shipping = shippingCharge({
      lines: ok.map((l) => {
        const v = variants.get(l.variantId)!;
        return { quantity: l.quantity, weightG: v.weightG, dimsCm: v.dimsCm, shippingClass: v.shippingClass };
      }),
      zone: input.destination.zone,
      serviceability: input.destination.serviceability,
      subtotal,
      couponDiscount,
      freeShippingCoupon: coupon?.applied === true && coupon.freeShipping,
      settings: input.settings.shipping,
    });
    if (!shipping.ok) blocking.push(shipping.error);
  } else if (!input.destination) {
    blocking.push('DESTINATION_REQUIRED');
  }
  const shippingAmount = shipping?.ok ? shipping.shipping : 0;

  const codFee = input.paymentMethod === 'COD' ? input.settings.payment.codFee : 0;   // never waived by free shipping
  const total = subtotal - couponDiscount + shippingAmount + codFee;

  const intra = input.destination ? isIntraState(input.destination.gstStateCode) : null;
  for (const l of ok) l.tax = lineTax(l.net, variants.get(l.variantId)!.gstRate!, intra);

  // COD limits apply to the total the customer would pay with COD, i.e. including the fee.
  const codTotal = subtotal - couponDiscount + shippingAmount + input.settings.payment.codFee;
  const cod = codAvailability(codTotal, input.settings.payment, input.destination?.serviceability ?? null);
  if (input.paymentMethod === 'COD' && !cod.available) blocking.push('COD_NOT_AVAILABLE');

  return {
    lines, subtotal, mrpTotal, mrpDiscount, coupon, couponDiscount, shipping, codFee, total,
    savings: mrpDiscount + couponDiscount + (shipping?.ok ? shipping.rate - shipping.shipping : 0),
    cod, blocking, warnings,
  };
}

/** Free-shipping progress for the cart banner: paise still needed after the coupon (0 once eligible). */
export function freeShippingRemaining(subtotal: Paise, couponDiscount: Paise, threshold: Paise): Paise {
  return Math.max(0, threshold - (subtotal - couponDiscount));
}

/** Per-unit refundable amount (database.md §4.5): net / quantity, the last unit absorbing the rounding. */
export function unitRefundAmounts(net: Paise, quantity: number): Paise[] {
  assertNonNegativeInt(net, 'net');
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new RangeError('quantity must be a positive integer');
  const unit = Math.floor(net / quantity);
  return Array.from({ length: quantity }, (_, i) => (i === quantity - 1 ? net - unit * (quantity - 1) : unit));
}
