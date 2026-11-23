import { describe, expect, it } from 'vitest';
import { taxApprovalBody } from './catalog-schemas.js';

describe('taxApprovalBody: HSN optional, GST rate required (0 = no GST)', () => {
  it('accepts a 0 % rate with no HSN (a seller not registered for GST)', () => {
    expect(taxApprovalBody.parse({ gstRate: 0 })).toEqual({ gstRate: 0 });
  });
  it('accepts an empty HSN (the form submits "" when the field is blank)', () => {
    expect(taxApprovalBody.parse({ hsnCode: '', gstRate: 0 })).toEqual({ hsnCode: '', gstRate: 0 });
  });
  it.each(['3907', '390730', '39073010'])('still accepts a valid HSN %s', (hsnCode) => {
    expect(taxApprovalBody.parse({ hsnCode, gstRate: 18 }).hsnCode).toBe(hsnCode);
  });
  it.each(['1', '390', '39073', '3907301', '123456789', '39AB', '39 07'])('a filled HSN must still be 4, 6 or 8 digits: rejects %s', (hsnCode) => {
    expect(taxApprovalBody.safeParse({ hsnCode, gstRate: 18 }).success).toBe(false);
  });
  it('trims the HSN, and whitespace only is not "empty"', () => {
    expect(taxApprovalBody.parse({ hsnCode: ' 3907 ', gstRate: 5 }).hsnCode).toBe('3907');
    expect(taxApprovalBody.safeParse({ hsnCode: '   ', gstRate: 5 }).success).toBe(false);
  });
  it('the GST rate is still required, within 0–40 and at most two decimals', () => {
    expect(taxApprovalBody.safeParse({ hsnCode: '3907' }).success).toBe(false);
    expect(taxApprovalBody.safeParse({}).success).toBe(false);
    for (const gstRate of [-0.01, 40.01, 18.255]) expect(taxApprovalBody.safeParse({ gstRate }).success).toBe(false);
    for (const gstRate of [0, 0.25, 5, 40]) expect(taxApprovalBody.safeParse({ gstRate }).success).toBe(true);
  });
  it('still rejects unknown fields', () => {
    expect(taxApprovalBody.safeParse({ gstRate: 0, approvedBy: 1 }).success).toBe(false);
  });
});
