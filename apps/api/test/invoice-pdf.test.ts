import type { Invoice } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { isTaxFree, renderInvoicePdf } from '../src/orders/invoice-pdf.js';

const line = (ratePercent: number, tax = 0) => ({ description: 'ArtQ UV Resin', sku: 'RES-UV-100G', hsn: null, quantity: 1, taxable: 31000 - tax, ratePercent, cgst: tax / 2, sgst: tax / 2, igst: 0, net: 31000 });
const party = (gstin: string | null) => ({ name: 'ArtQ', lines: ['Chennai'], state: 'Tamil Nadu', stateCode: '33', gstin });
const invoice = (over: Partial<Invoice> = {}, lines = [line(0)]): Invoice => ({
  id: 1, number: 'AQ-1', kind: 'INVOICE', issuedAt: new Date('2026-11-23T10:00:00Z'), placeOfSupply: '33', taxableTotal: 31000,
  cgstTotal: 0, sgstTotal: 0, igstTotal: 0, roundingAdjustment: 0, grandTotal: 31000, lines, sellerSnapshot: party(null), buyerSnapshot: party(null), ...over,
} as unknown as Invoice);

describe('isTaxFree: no GST charged → a bill of supply', () => {
  it('true when every line is 0 % and every tax total is zero', () => {
    expect(isTaxFree(invoice(), [line(0), line(0)])).toBe(true);
  });
  it('false as soon as any line carries a rate', () => {
    expect(isTaxFree(invoice(), [line(0), line(5)])).toBe(false);
  });
  it.each([['cgstTotal'], ['sgstTotal'], ['igstTotal']])('false when %s is not zero (a 0 % label never hides charged tax)', (k) => {
    expect(isTaxFree(invoice({ [k]: 100 } as Partial<Invoice>), [line(0)])).toBe(false);
  });
  it('false for a normal GST invoice', () => {
    expect(isTaxFree(invoice({ cgstTotal: 740, sgstTotal: 740 }), [line(5, 1480)])).toBe(false);
  });
  it('rates stored as strings (Decimal) are compared numerically', () => {
    expect(isTaxFree(invoice(), [{ ratePercent: '0.00' as unknown as number }])).toBe(true);
  });
});

describe('renderInvoicePdf renders both document kinds', () => {
  const isPdf = (b: Buffer) => b.subarray(0, 5).toString() === '%PDF-';
  it('a bill of supply (no GST, no GSTIN)', async () => { expect(isPdf(await renderInvoicePdf(invoice(), 'AQ-ORD-1'))).toBe(true); });
  it('a credit note against a bill of supply', async () => { expect(isPdf(await renderInvoicePdf(invoice({ kind: 'CREDIT_NOTE' } as Partial<Invoice>), 'AQ-ORD-1', 'AQ-1'))).toBe(true); });
  it('a normal GST tax invoice is unchanged', async () => {
    const inv = invoice({ cgstTotal: 740, sgstTotal: 740, sellerSnapshot: party('33ABCDE1234F1Z5') as never }, [line(5, 1480)]);
    expect(isPdf(await renderInvoicePdf(inv, 'AQ-ORD-1'))).toBe(true);
  });
});
