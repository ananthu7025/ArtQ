import { describe, expect, it } from 'vitest';
import { discountPercent, formatINR, toPaise } from './money.js';
import { healthResponse } from './schemas.js';

describe('money', () => {
  it('converts rupees to integer paise', () => { expect(toPaise(849)).toBe(84900); expect(toPaise(0.1 + 0.2)).toBe(30); });
  it('formats INR without decimals for whole rupees', () => {
    expect(formatINR(84900)).toBe('₹849');
    expect(formatINR(1310000)).toBe('₹13,100');
    expect(formatINR(805050)).toBe('₹8,050.50');
  });
  it('computes discount percent', () => { expect(discountPercent(9000, 12000)).toBe(25); expect(discountPercent(9000, null)).toBeNull(); });
});

describe('schemas', () => {
  it('rejects unknown keys', () => {
    expect(healthResponse.safeParse({ status: 'ok', service: 'api', version: '1' }).success).toBe(true);
    expect(healthResponse.safeParse({ status: 'ok', service: 'api', version: '1', extra: 1 }).success).toBe(false);
  });
});
