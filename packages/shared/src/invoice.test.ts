import { describe, expect, it } from 'vitest';
import { amountInWords, buildInvoiceContent, financialYear, type InvoiceParty } from './invoice.js';
import { shipOrderBody } from './order-admin-schemas.js';

const party: InvoiceParty = { name: 'ArtQ', lines: ['Kochi'], stateCode: '32', state: 'Kerala', gstin: null };
const order = { items: [{ name: 'Epoxy Resin', label: '500 ml', sku: 'RES-500', hsn: '3907', quantity: 2, net: 94_800, ratePercent: 18 }, { name: 'Mica', label: '', sku: 'MICA', hsn: '3206', quantity: 1, net: 10_000, ratePercent: 12 }], shippingFee: 7000, codFee: 4000, total: 115_800 };
const build = (placeOfSupply: string, shippingTaxRule: 'CA_DECISION' | 'TAXED' | 'EXEMPT' = 'CA_DECISION') =>
  buildInvoiceContent(order, { seller: party, buyer: party, placeOfSupply, storeStateCode: '32', shippingTaxRule, at: new Date('2026-10-07T06:00:00Z') });

describe('tax invoice content (task 5.2)', () => {
  it('inside Kerala: CGST + SGST per line (rounded once per line); shipping and COD fee at the highest item rate (D-3 default)', () => {
    const c = build('32');
    expect(c.fy).toBe('26-27');
    expect(c.lines.map((l) => [l.kind, l.description, l.ratePercent, l.taxable, l.cgst, l.sgst, l.igst])).toEqual([
      ['ITEM', 'Epoxy Resin (500 ml)', 18, 80_339, 7230, 7231, 0],
      ['ITEM', 'Mica', 12, 8929, 535, 536, 0],
      ['SHIPPING', 'Shipping charges', 18, 5932, 534, 534, 0],
      ['COD_FEE', 'Cash on delivery fee', 18, 3390, 305, 305, 0],
    ]);
    expect(c.taxable_total + c.cgst_total + c.sgst_total + c.igst_total).toBe(115_800);
    expect(c).toMatchObject({ igst_total: 0, rounding_adjustment: 0, grand_total: 115_800, place_of_supply: '32' });
  });
  it('outside Kerala: IGST only; EXEMPT charges carry no tax; lines that do not add up to the total are refused', () => {
    const c = build('29', 'EXEMPT');
    expect(c.cgst_total + c.sgst_total).toBe(0);
    expect(c.lines.find((l) => l.kind === 'SHIPPING')).toMatchObject({ ratePercent: 0, taxable: 7000, igst: 0 });
    expect(c.lines[0]).toMatchObject({ igst: 14_461, cgst: 0 });
    expect(() => buildInvoiceContent({ ...order, total: 115_801 }, { seller: party, buyer: party, placeOfSupply: '32', storeStateCode: '32', shippingTaxRule: 'TAXED', at: new Date() })).toThrow(/do not add up/);
    expect(() => build('KL')).toThrow(/place of supply/);
  });
  it('financial year turns on 1 April, India time', () => {
    expect(financialYear(new Date('2027-03-31T18:29:59Z'))).toBe('26-27');   // 23:59:59 IST on 31 March
    expect(financialYear(new Date('2027-03-31T18:30:00Z'))).toBe('27-28');   // 00:00 IST on 1 April
    expect(financialYear(new Date('2099-12-31T00:00:00Z'))).toBe('99-00');
  });
  it('amount in words (Indian numbering)', () => {
    expect(amountInWords(115_800)).toBe('Rupees One Thousand One Hundred Fifty Eight Only');
    expect(amountInWords(1_234_567_850)).toBe('Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Fifty Paise Only');
    expect(amountInWords(5)).toBe('Rupees Zero and Five Paise Only');
    expect(() => amountInWords(-1)).toThrow();
  });
});

describe('shipOrderBody', () => {
  const ok = { courierName: 'DTDC', awbNumber: 'd123-456' };
  it('normalises; optional link and weight; boundaries', () => {
    expect(shipOrderBody.parse(ok)).toEqual({ courierName: 'DTDC', awbNumber: 'D123-456', trackingUrl: null, weightG: null, notifyCustomer: true });
    expect(shipOrderBody.parse({ ...ok, trackingUrl: ' ', weightG: 100_000 })).toMatchObject({ trackingUrl: null, weightG: 100_000 });
    expect(shipOrderBody.safeParse({ ...ok, awbNumber: 'A'.repeat(40) }).success).toBe(true);
    const issues = (b: object) => Object.fromEntries((shipOrderBody.safeParse(b).error?.issues ?? []).map((i) => [i.path.join('.'), i.message]));
    expect(issues({})).toEqual({ courierName: 'Enter the courier', awbNumber: 'Enter the AWB / tracking number' });
    expect(issues({ ...ok, awbNumber: 'A'.repeat(41) })).toEqual({ awbNumber: 'Use 4 to 40 letters, digits or dashes' });
    expect(issues({ ...ok, awbNumber: 'ab c' })).toEqual({ awbNumber: 'Use 4 to 40 letters, digits or dashes' });
    expect(issues({ ...ok, trackingUrl: 'http://x.in/t' })).toEqual({ trackingUrl: 'Enter a full https:// link' });
    expect(issues({ ...ok, weightG: 100_001 })).toEqual({ weightG: 'At most 100 kg' });
    expect(issues({ ...ok, weightG: 0 })).toEqual({ weightG: 'Use at least 1 g' });
    expect(issues({ ...ok, extra: 1 })).toMatchObject({ '': expect.any(String) });
  });
});
