import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, settingSchemas } from './settings.js';
import { pincodeRuleBody, surfaceAvailable, zoneBody } from './shipping-admin-schemas.js';

describe('surface reach (D-7)', () => {
  it.each([['744101', false], ['682551', false], ['682555', false], ['682011', true], ['110001', true], ['174401', true]])('%s → %s', (pin, ok) => {
    expect(surfaceAvailable(pin, DEFAULT_SETTINGS.SHIPPING.airOnlyPincodePrefixes)).toBe(ok);
  });
  it('a SHIPPING value stored before the air-only list existed still reads, with the default list', () => {
    const { airOnlyPincodePrefixes: _, ...old } = DEFAULT_SETTINGS.SHIPPING;
    expect(settingSchemas.SHIPPING.parse(old).airOnlyPincodePrefixes).toEqual(['744', '68255']);
    expect(settingSchemas.SHIPPING.parse({ ...old, airOnlyPincodePrefixes: [] }).airOnlyPincodePrefixes).toEqual([]);
  });
});

describe('zoneBody and pincodeRuleBody', () => {
  it('20 slabs allowed, 21 not; equal rates for a heavier slab are fine', () => {
    const slabs = (n: number) => Array.from({ length: n }, (_, i) => ({ maxWeightG: (i + 1) * 100, rate: 1000 }));
    expect(zoneBody.safeParse({ name: 'Z', extraPerKg: 0, slabs: slabs(20) }).success).toBe(true);
    expect(zoneBody.safeParse({ name: 'Z', extraPerKg: 0, slabs: slabs(21) }).success).toBe(false);
  });
  it('days: neither is the default; both with max ≥ min', () => {
    expect(pincodeRuleBody.parse({ isServiceable: true, codAvailable: true })).toEqual({ isServiceable: true, codAvailable: true, eddMinDays: null, eddMaxDays: null, note: null });
    expect(pincodeRuleBody.safeParse({ isServiceable: true, codAvailable: true, eddMinDays: 3, eddMaxDays: 3 }).success).toBe(true);
    expect(pincodeRuleBody.safeParse({ isServiceable: true, codAvailable: true, eddMinDays: 61, eddMaxDays: 61 }).success).toBe(false);
  });
});
