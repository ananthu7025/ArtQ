import { describe, expect, it } from 'vitest';
import { checkoutInitiateBody, checkoutQuoteBody, gstinField, indianMobileField } from './checkout-schemas.js';

describe('indianMobileField', () => {
  it.each([['9847012345', '+919847012345'], ['+91 98470 12345', '+919847012345'], ['098470-12345', '+919847012345'], ['919847012345', '+919847012345'], ['6000000000', '+916000000000']])('%s → %s', (v, out) => {
    expect(indianMobileField.parse(v)).toBe(out);
  });
  it.each(['', '5847012345', '984701234', '98470123456', '+1 9847012345', 'abcdefghij'])('%s is refused', (v) => {
    expect(indianMobileField.safeParse(v).error?.issues[0]?.message).toBe('Enter a 10-digit mobile number');
  });
});

describe('gstinField', () => {
  it('normalises case; refuses a wrong shape', () => {
    expect(gstinField.parse(' 32abcde1234f1z5 ')).toBe('32ABCDE1234F1Z5');
    for (const bad of ['32ABCDE1234F1Z', '32ABCDE1234F1X5', 'AB1234567890123']) expect(gstinField.safeParse(bad).success, bad).toBe(false);
  });
});

describe('checkoutInitiateBody', () => {
  const address = { fullName: 'Hema R', phone: '+919876543210', line1: '12 Rose Villa', city: 'Kochi', stateId: 18, pincode: '682016' };
  const base = { contact: { email: 'hema@example.com', phone: '98765 43210' }, shippingAddress: address, paymentMethod: 'RAZORPAY', expectedTotal: 134_900, acceptTerms: true };
  const issues = (o: object) => { const r = checkoutInitiateBody.safeParse({ ...base, ...o }); return r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [i.path.join('.'), i.message])); };
  it('the api.md example shape parses, with defaults', () => {
    expect(checkoutInitiateBody.parse(base)).toMatchObject({ contact: { phone: '+919876543210', sendSetPasswordLink: false }, shippingAddressId: null, shippingAddress: { label: 'HOME', save: false }, billingSameAsShipping: true, gstin: null, customerNote: null });
  });
  it('exactly one delivery address; billing when different; a business name with a GSTIN; terms; note 500', () => {
    expect(issues({ shippingAddress: null })).toEqual({ shippingAddress: 'Choose or add a delivery address' });
    expect(issues({ shippingAddressId: 3 })).toEqual({ shippingAddress: 'Choose or add a delivery address' });
    expect(issues({ billingSameAsShipping: false })).toEqual({ billingAddress: 'Add the billing address' });
    expect(issues({ gstin: '32ABCDE1234F1Z5' })).toEqual({ businessName: 'Enter the business name for the GST invoice' });
    expect(issues({ gstin: '32ABCDE1234F1Z5', businessName: 'Hema Arts' })).toEqual({});
    expect(issues({ acceptTerms: false })).toEqual({ acceptTerms: 'Accept the terms to place your order' });
    expect(issues({ customerNote: 'x'.repeat(500) })).toEqual({});
    expect(issues({ customerNote: 'x'.repeat(501) })).toEqual({ customerNote: 'Use at most 500 characters' });
    expect(issues({ paymentMethod: 'UPI' })).toHaveProperty('paymentMethod');
    expect(issues({ extra: 1 })).toHaveProperty('');
  });
});

describe('checkoutQuoteBody', () => {
  it('a saved address or a pincode, not both, not neither', () => {
    expect(checkoutQuoteBody.parse({ pincode: '682011' })).toEqual({ pincode: '682011', paymentMethod: 'RAZORPAY' });
    expect(checkoutQuoteBody.safeParse({ shippingAddressId: 1, paymentMethod: 'COD' }).success).toBe(true);
    expect(checkoutQuoteBody.safeParse({}).success).toBe(false);
    expect(checkoutQuoteBody.safeParse({ shippingAddressId: 1, pincode: '682011' }).success).toBe(false);
  });
});
