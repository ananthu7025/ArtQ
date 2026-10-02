import { describe, expect, it } from 'vitest';
import { includedTax, isIntraState, lineTax, rateToBasisPoints } from './tax.js';

describe('included GST, rounded once per line (database.md §4.4)', () => {
  it.each([
    // net, rate %, taxable, tax
    [1000, 18, 847, 153],          // 847.46
    [84_900, 18, 71_949, 12_951],  // ₹849 line
    [10_000, 5, 9524, 476],        // 9523.81
    [10_500, 5, 10_000, 500],
    [103, 3, 100, 3],
    [10_025, 0.25, 10_000, 25],
    [14_000, 40, 10_000, 4000],
    [9000, 0, 9000, 0],
    [0, 18, 0, 0],
    [16, 28, 13, 3],               // 12.5 → half up to 13
    [48, 28, 38, 10],              // 37.5 → 38
    [1, 18, 1, 0],
  ])('net %i at %s %% → taxable %i + tax %i', (net, rate, taxable, tax) => {
    expect(includedTax(net, rate)).toEqual({ taxable, tax });
  });

  it('intra-state splits CGST = floor(tax/2), SGST = rest; inter-state is all IGST; unknown destination has no split', () => {
    expect(lineTax(1000, 18, true)).toEqual({ ratePercent: 18, taxable: 847, tax: 153, cgst: 76, sgst: 77, igst: 0 });
    expect(lineTax(1000, 18, false)).toEqual({ ratePercent: 18, taxable: 847, tax: 153, cgst: 0, sgst: 0, igst: 153 });
    expect(lineTax(1000, 18, null)).toEqual({ ratePercent: 18, taxable: 847, tax: 153, cgst: null, sgst: null, igst: null });
    expect(lineTax(84_900, 18, true)).toMatchObject({ cgst: 6475, sgst: 6476 });
  });

  it('place of supply: Kerala (32) is intra-state', () => {
    expect(isIntraState('32')).toBe(true);
    expect(isIntraState('29')).toBe(false);
    expect(isIntraState('07', '07')).toBe(true);
  });

  it.each([-1, 40.01, 18.555, Number.NaN, Number.POSITIVE_INFINITY])('rejects rate %s', (rate) => {
    expect(() => rateToBasisPoints(rate)).toThrow(/GST rate/);
  });
  it.each([-1, 1.5, Number.NaN])('rejects net %s', (net) => {
    expect(() => includedTax(net, 18)).toThrow(/net/);
  });
});
