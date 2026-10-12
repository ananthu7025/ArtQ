// Settings bodies (task 6.5): each merged into the stored value still passes the stored schema; the rules the page
// shows (GSTIN ↔ state, one way to pay, COD min ≤ max, limits at the boundary, unique emails); permission labels.
import { describe, expect, it } from 'vitest';
import { PERMISSION_LABEL, PERMISSIONS } from './permissions.js';
import { ADMIN_SETTING_BODIES, ADMIN_SETTING_KEYS, paymentSettingsBody, storeInfoBody, notifySettingsBody, orderSettingsBody, taxSettingsBody } from './settings-admin-schemas.js';
import { DEFAULT_SETTINGS, settingSchemas } from './settings.js';

const issues = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) => Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join('.'), i.message]));
const store = { name: 'ArtQ', legalName: 'ArtQ Crafts LLP', gstin: '32abcde1234f1z5', address: 'Kochi', stateCode: '32', phone: '+91 98470 12345', email: 'hello@artq.in', whatsapp: '' };
const pay = { razorpayEnabled: true, codEnabled: true, codFee: 4000, codMin: 20_000, codMax: 500_000, pendingExpiryMinutes: 30 };

it('every admin body, merged into the defaults, is a valid stored value', () => {
  const samples = { STORE_INFO: store, PAYMENT: pay, ORDER: { returnWindowHours: 72 }, TAX: { shippingTaxRule: 'EXEMPT' }, NOTIFY: { adminEmails: ['a@artq.in'] } } as const;
  for (const k of ADMIN_SETTING_KEYS) {
    const body = ADMIN_SETTING_BODIES[k].parse(samples[k]);
    expect(settingSchemas[k].safeParse({ ...DEFAULT_SETTINGS[k], ...body }).success, k).toBe(true);
  }
});

describe('store info', () => {
  it('GSTIN in capitals; blanks become null; the GSTIN must start with the state code', () => {
    expect(storeInfoBody.parse(store)).toEqual({ ...store, gstin: '32ABCDE1234F1Z5', whatsapp: null });
    expect(storeInfoBody.parse({ ...store, gstin: '', legalName: ' ', email: '' })).toMatchObject({ gstin: null, legalName: null, email: null });
    expect(issues(storeInfoBody.safeParse({ ...store, stateCode: '29' }))).toEqual({ gstin: 'A GSTIN starts with its state’s code (29 for the state chosen)' });
    expect(issues(storeInfoBody.safeParse({ ...store, gstin: '32ABC' }))).toEqual({ gstin: 'Enter a 15-character GSTIN, like 32ABCDE1234F1Z5' });
  });
  it('required name; limits at the boundary; phone format; unknown fields refused', () => {
    expect(issues(storeInfoBody.safeParse({ ...store, name: ' ' }))).toEqual({ name: 'Enter the store name' });
    expect(storeInfoBody.safeParse({ ...store, name: 'n'.repeat(120), address: 'a'.repeat(500) }).success).toBe(true);
    expect(issues(storeInfoBody.safeParse({ ...store, name: 'n'.repeat(121), address: 'a'.repeat(501) }))).toEqual({ name: 'Use at most 120 characters', address: 'Use at most 500 characters' });
    expect(issues(storeInfoBody.safeParse({ ...store, phone: 'call me' }))).toEqual({ phone: 'Use a phone number like +91 98470 12345' });
    expect(storeInfoBody.safeParse({ ...store, logo: 'x' }).success).toBe(false);
  });
});

describe('payments', () => {
  it('one way to pay; COD min ≤ max (equal allowed); fee and minutes at the boundary', () => {
    expect(issues(paymentSettingsBody.safeParse({ ...pay, razorpayEnabled: false, codEnabled: false }))).toEqual({ codEnabled: 'Keep at least one way to pay switched on' });
    expect(paymentSettingsBody.safeParse({ ...pay, codMin: 500_000 }).success).toBe(true);
    expect(issues(paymentSettingsBody.safeParse({ ...pay, codMin: 500_001 }))).toEqual({ codMax: 'Use at least the minimum' });
    expect(paymentSettingsBody.safeParse({ ...pay, codFee: 100_000, pendingExpiryMinutes: 5 }).success).toBe(true);
    expect(paymentSettingsBody.safeParse({ ...pay, pendingExpiryMinutes: 120 }).success).toBe(true);
    expect(issues(paymentSettingsBody.safeParse({ ...pay, codFee: 100_001, pendingExpiryMinutes: 4 }))).toEqual({ codFee: 'At most ₹1,000', pendingExpiryMinutes: 'At least 5 minutes' });
    expect(issues(paymentSettingsBody.safeParse({ ...pay, pendingExpiryMinutes: 121, codFee: 1.5 }))).toEqual({ pendingExpiryMinutes: 'At most 120 minutes', codFee: 'Use whole paise' });
    expect(paymentSettingsBody.safeParse({ ...pay, autoRefundExcessCapture: false }).success).toBe(false);   // not edited here
  });
});

it('returns, tax and staff emails', () => {
  expect(orderSettingsBody.safeParse({ returnWindowHours: 0 }).success).toBe(true);
  expect(orderSettingsBody.safeParse({ returnWindowHours: 720 }).success).toBe(true);
  expect(issues(orderSettingsBody.safeParse({ returnWindowHours: 721 }))).toEqual({ returnWindowHours: 'At most 720 hours (30 days)' });
  expect(issues(orderSettingsBody.safeParse({ returnWindowHours: -1 }))).toEqual({ returnWindowHours: 'Use 0 or more (0 = no returns)' });
  expect(taxSettingsBody.safeParse({ shippingTaxRule: 'TAXED' }).success).toBe(true);
  expect(taxSettingsBody.safeParse({ shippingTaxRule: 'HALF' }).success).toBe(false);
  expect(notifySettingsBody.safeParse({ adminEmails: [] }).success).toBe(true);
  expect(notifySettingsBody.safeParse({ adminEmails: Array.from({ length: 10 }, (_, i) => `a${i}@artq.in`) }).success).toBe(true);
  expect(issues(notifySettingsBody.safeParse({ adminEmails: Array.from({ length: 11 }, (_, i) => `a${i}@artq.in`) }))).toEqual({ adminEmails: 'At most 10 addresses' });
  expect(issues(notifySettingsBody.safeParse({ adminEmails: ['a@artq.in', 'A@ARTQ.in'] }))).toEqual({ adminEmails: 'Each address only once' });
  expect(issues(notifySettingsBody.safeParse({ adminEmails: ['nope'] }))).toEqual({ 'adminEmails.0': 'Enter a valid email address' });
});

it('every permission has a label', () => {
  expect(PERMISSIONS.filter((p) => !PERMISSION_LABEL[p]?.trim())).toEqual([]);
});
