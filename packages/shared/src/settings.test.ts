import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseSetting, PUBLIC_SETTING_KEYS, SETTING_KEYS, settingSchemas } from './settings.js';

describe('settings schemas', () => {
  it('cover exactly the keys of database.md §3.13', () => {
    expect([...SETTING_KEYS].sort()).toEqual(['ANNOUNCEMENT_BAR', 'HERO', 'HOME_SECTIONS', 'INSTAGRAM_MOMENTS', 'NOTIFY', 'ORDER', 'PAYMENT', 'SHIPPING', 'SOCIAL', 'STORE_INFO', 'TAX']);
    expect(PUBLIC_SETTING_KEYS.every((k) => SETTING_KEYS.includes(k))).toBe(true);
    expect(PUBLIC_SETTING_KEYS).not.toContain('TAX');
    expect(PUBLIC_SETTING_KEYS).not.toContain('NOTIFY');
  });

  it.each(SETTING_KEYS)('default %s is valid', (key) => {
    expect(parseSetting(key, DEFAULT_SETTINGS[key])).toEqual(DEFAULT_SETTINGS[key]);
  });

  it('documented example values', () => {
    expect(DEFAULT_SETTINGS.SHIPPING).toMatchObject({ freeThreshold: 100_000, packagingWeightG: 150, volumetricDivisor: 5000, heavyCapG: 10_000 });
    expect(DEFAULT_SETTINGS.PAYMENT).toMatchObject({ codFee: 4000, codMin: 20_000, codMax: 500_000, pendingExpiryMinutes: 30 });
    expect(DEFAULT_SETTINGS.STORE_INFO.stateCode).toBe('32');
  });

  it.each([
    ['SHIPPING', { ...DEFAULT_SETTINGS.SHIPPING, freeThreshold: -1 }],
    ['SHIPPING', { ...DEFAULT_SETTINGS.SHIPPING, freeThreshold: 99.5 }],
    ['SHIPPING', { ...DEFAULT_SETTINGS.SHIPPING, estimatedDays: { min: 8, max: 7 } }],
    ['SHIPPING', { ...DEFAULT_SETTINGS.SHIPPING, unknownKey: 1 }],
    ['PAYMENT', { ...DEFAULT_SETTINGS.PAYMENT, codMin: 600_000 }],
    ['PAYMENT', { ...DEFAULT_SETTINGS.PAYMENT, pendingExpiryMinutes: 1 }],
    ['PAYMENT', { ...DEFAULT_SETTINGS.PAYMENT, razorpayKeySecret: 'x' }],      // secrets never live in settings
    ['STORE_INFO', { ...DEFAULT_SETTINGS.STORE_INFO, gstin: 'NOT-A-GSTIN' }],
    ['STORE_INFO', { ...DEFAULT_SETTINGS.STORE_INFO, stateCode: 'KL' }],
    ['NOTIFY', { ...DEFAULT_SETTINGS.NOTIFY, adminEmails: ['nope'] }],
    ['TAX', { ...DEFAULT_SETTINGS.TAX, pricesIncludeTax: false }],
    ['ANNOUNCEMENT_BAR', { enabled: true, messages: [''] }],
  ] as const)('rejects invalid %s value %#', (key, value) => {
    expect(settingSchemas[key].safeParse(value).success).toBe(false);
  });

  it('accepts a well-formed GSTIN', () => {
    expect(parseSetting('STORE_INFO', { ...DEFAULT_SETTINGS.STORE_INFO, gstin: '32ABCDE1234F1Z5' }).gstin).toBe('32ABCDE1234F1Z5');
  });
});
