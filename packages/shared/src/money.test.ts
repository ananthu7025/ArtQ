import { describe, expect, it } from 'vitest';
import { allocateLargestRemainder, discountPercent, divCeil, divRoundHalfUp, formatINR, toPaise } from './money.js';
import { healthResponse } from './schemas.js';

describe('money', () => {
  it('converts rupees to integer paise', () => { expect(toPaise(849)).toBe(84900); expect(toPaise(0.1 + 0.2)).toBe(30); });
  it('rejects non-finite rupees', () => { expect(() => toPaise(Number.NaN)).toThrow(/finite/); });
  it('formats INR without decimals for whole rupees', () => {
    expect(formatINR(84900)).toBe('₹849');
    expect(formatINR(1310000)).toBe('₹13,100');
    expect(formatINR(805050)).toBe('₹8,050.50');
    expect(formatINR(0)).toBe('₹0');
    expect(() => formatINR(1.5)).toThrow(/integer/);
  });

  it.each([
    [9000, 12000, 25], [7500, 20000, 63], [12500, 20000, 38], [1, 3, 67], [9000, null, null], [9000, 9000, null], [9000, 8000, null],
  ])('discountPercent(%s, %s) = %s', (price, mrp, pct) => { expect(discountPercent(price, mrp)).toBe(pct); });

  it.each([[5, 2, 3], [4, 2, 2], [1, 3, 0], [2, 3, 1], [0, 7, 0], [7, 2, 4]])('divRoundHalfUp(%i, %i) = %i', (a, b, r) => {
    expect(divRoundHalfUp(a, b)).toBe(r);
  });
  it.each([[0, 1000, 0], [1, 1000, 1], [1000, 1000, 1], [1001, 1000, 2], [2150, 1000, 3]])('divCeil(%i, %i) = %i', (a, b, r) => {
    expect(divCeil(a, b)).toBe(r);
  });
  it('division helpers reject bad operands', () => {
    expect(() => divRoundHalfUp(1, 0)).toThrow(/divisor/);
    expect(() => divCeil(-1, 2)).toThrow(/dividend/);
    expect(() => divCeil(1.5, 2)).toThrow(/dividend/);
  });
});

describe('allocateLargestRemainder', () => {
  it.each([
    [100, [1, 1, 1], [34, 33, 33]],
    [10, [50, 30, 20], [5, 3, 2]],
    [1, [1, 1], [1, 0]],
    [7, [10, 0, 10], [4, 0, 3]],
    [0, [5, 5], [0, 0]],
    [8490, [84_900], [8490]],
  ])('%i over %j → %j', (total, weights, shares) => {
    expect(allocateLargestRemainder(total, weights)).toEqual(shares);
  });

  it('shares always sum to the total and never exceed their weight (deterministic sweep)', () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed % n; };
    for (let k = 0; k < 500; k++) {
      const weights = Array.from({ length: 1 + rnd(6) }, () => rnd(200_000));
      const sum = weights.reduce((s, w) => s + w, 0);
      if (sum === 0) continue;
      const total = rnd(sum + 1);
      const shares = allocateLargestRemainder(total, weights);
      expect(shares.reduce((s, x) => s + x, 0)).toBe(total);
      shares.forEach((s, i) => expect(s).toBeLessThanOrEqual(weights[i]!));
    }
  });

  it('rejects impossible or invalid allocations', () => {
    expect(() => allocateLargestRemainder(1, [0, 0])).toThrow(/zero weights/);
    expect(() => allocateLargestRemainder(-1, [1])).toThrow(/total/);
    expect(() => allocateLargestRemainder(1, [1, -1])).toThrow(/weights\[1\]/);
  });
});

describe('schemas', () => {
  it('rejects unknown keys', () => {
    expect(healthResponse.safeParse({ status: 'ok', service: 'api', version: '1' }).success).toBe(true);
    expect(healthResponse.safeParse({ status: 'ok', service: 'api', version: '1', extra: 1 }).success).toBe(false);
  });
});
