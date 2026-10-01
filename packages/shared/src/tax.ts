// GST included in GST-inclusive prices (product.md §8.1), rounded once per order line (database.md §4.4):
//   included tax = net − round_half_up(net × 100 / (100 + rate));  CGST = floor(tax / 2), SGST = tax − CGST;  IGST = tax.
// Rates are percentages with up to two decimals (DB: DECIMAL(4,2), 0–40), handled exactly in basis points.
import { assertNonNegativeInt, divRoundHalfUp, type Paise } from './money.js';

/** The store's GST state code (Kerala). Intra-state supply ⇒ CGST + SGST, otherwise IGST. */
export const STORE_GST_STATE_CODE = '32';

export type LineTax = {
  ratePercent: number;
  taxable: Paise;
  tax: Paise;
  /** null while the place of supply is unknown (no destination yet). */
  cgst: Paise | null;
  sgst: Paise | null;
  igst: Paise | null;
};

/** Converts a percentage with at most two decimals (e.g. 18, 0.25) to basis points. */
export function rateToBasisPoints(ratePercent: number): number {
  const bp = Math.round(ratePercent * 100);
  if (!Number.isFinite(ratePercent) || ratePercent < 0 || ratePercent > 40 || Math.abs(bp - ratePercent * 100) > 1e-6) {
    throw new RangeError(`GST rate must be 0–40 with at most two decimals, got ${ratePercent}`);
  }
  return bp;
}

/** Taxable value and included tax of a GST-inclusive net amount. */
export function includedTax(net: Paise, ratePercent: number): { taxable: Paise; tax: Paise } {
  assertNonNegativeInt(net, 'net');
  const bp = rateToBasisPoints(ratePercent);
  const taxable = divRoundHalfUp(net * 10_000, 10_000 + bp);
  return { taxable, tax: net - taxable };
}

export function isIntraState(destinationGstCode: string, storeGstCode = STORE_GST_STATE_CODE): boolean {
  return destinationGstCode === storeGstCode;
}

/** Full line tax; `intraState` null ⇒ split not yet known. */
export function lineTax(net: Paise, ratePercent: number, intraState: boolean | null): LineTax {
  const { taxable, tax } = includedTax(net, ratePercent);
  if (intraState === null) return { ratePercent, taxable, tax, cgst: null, sgst: null, igst: null };
  if (!intraState) return { ratePercent, taxable, tax, cgst: 0, sgst: 0, igst: tax };
  const cgst = Math.floor(tax / 2);
  return { ratePercent, taxable, tax, cgst, sgst: tax - cgst, igst: 0 };
}
