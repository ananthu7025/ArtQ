// Tax invoice content (task 5.2; architecture.md §10.4, product.md §8.1, database.md §4.4 rounding): computed once at
// dispatch from the order's snapshot lines and stored immutably by aq_dispatch_order. Prices include GST; each line's
// tax is extracted with `lineTax` (CGST+SGST inside the store's state, IGST outside). Shipping and the COD fee are
// lines of their own, taxed per decision D-3: until the accountant decides, at the highest item rate; `EXEMPT` = 0 %.
// The lines add up to the order total exactly, so the rounding adjustment is 0 (kept for the document format).
import { lineTax } from './tax.js';

export type InvoiceLineKind = 'ITEM' | 'SHIPPING' | 'COD_FEE';
export type InvoiceLine = {
  kind: InvoiceLineKind; description: string; sku: string | null; hsn: string | null; quantity: number;
  /** GST-inclusive amount of the line after discounts. */
  net: number; ratePercent: number; taxable: number; cgst: number; sgst: number; igst: number;
};
export type InvoiceParty = { name: string; lines: string[]; stateCode: string | null; state: string | null; gstin: string | null; phone?: string | null; email?: string | null };
export type InvoiceContent = {
  fy: string; seller: InvoiceParty; buyer: InvoiceParty; place_of_supply: string; lines: InvoiceLine[];
  taxable_total: number; cgst_total: number; sgst_total: number; igst_total: number; rounding_adjustment: number; grand_total: number;
};
export type ShippingTaxRule = 'CA_DECISION' | 'TAXED' | 'EXEMPT';

/** Indian financial year (April–March) of an instant, in India time: 2026-10-07 → "26-27", 2027-03-31 → "26-27". */
export function financialYear(at: Date): string {
  const ist = new Date(at.getTime() + 5.5 * 3_600_000);
  const y = ist.getUTCFullYear() - (ist.getUTCMonth() < 3 ? 1 : 0);
  return `${String(y % 100).padStart(2, '0')}-${String((y + 1) % 100).padStart(2, '0')}`;
}

export type InvoiceOrder = {
  items: { name: string; label: string; sku: string; hsn: string | null; quantity: number; net: number; ratePercent: number }[];
  shippingFee: number; codFee: number; total: number;
};

export function buildInvoiceContent(o: InvoiceOrder, a: { seller: InvoiceParty; buyer: InvoiceParty; placeOfSupply: string; storeStateCode: string; shippingTaxRule: ShippingTaxRule; at: Date }): InvoiceContent {
  if (!/^\d{2}$/.test(a.placeOfSupply)) throw new RangeError(`place of supply must be a 2-digit GST state code, got ${a.placeOfSupply}`);
  const intra = a.placeOfSupply === a.storeStateCode;
  const line = (kind: InvoiceLineKind, description: string, sku: string | null, hsn: string | null, quantity: number, net: number, ratePercent: number): InvoiceLine => {
    const t = lineTax(net, ratePercent, intra);
    return { kind, description, sku, hsn, quantity, net, ratePercent, taxable: t.taxable, cgst: t.cgst ?? 0, sgst: t.sgst ?? 0, igst: t.igst ?? 0 };
  };
  const lines = o.items.map((i) => line('ITEM', i.label ? `${i.name} (${i.label})` : i.name, i.sku, i.hsn, i.quantity, i.net, i.ratePercent));
  const chargeRate = a.shippingTaxRule === 'EXEMPT' ? 0 : Math.max(0, ...o.items.map((i) => i.ratePercent));
  if (o.shippingFee > 0) lines.push(line('SHIPPING', 'Shipping charges', null, null, 1, o.shippingFee, chargeRate));
  if (o.codFee > 0) lines.push(line('COD_FEE', 'Cash on delivery fee', null, null, 1, o.codFee, chargeRate));
  const sum = (k: 'taxable' | 'cgst' | 'sgst' | 'igst') => lines.reduce((s, l) => s + l[k], 0);
  const net = lines.reduce((s, l) => s + l.net, 0);
  if (net !== o.total) throw new RangeError(`invoice lines (${net}) do not add up to the order total (${o.total})`);
  return {
    fy: financialYear(a.at), seller: a.seller, buyer: a.buyer, place_of_supply: a.placeOfSupply, lines,
    taxable_total: sum('taxable'), cgst_total: sum('cgst'), sgst_total: sum('sgst'), igst_total: sum('igst'), rounding_adjustment: 0, grand_total: o.total,
  };
}

/** "Rupees One Thousand One Hundred Eight and Fifty Paise Only" (Indian numbering). */
export function amountInWords(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0) throw new RangeError('amount must be a non-negative whole number of paise');
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (n: number) => (n < 20 ? ones[n]! : `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ''}`);
  const three = (n: number) => [n >= 100 ? `${ones[Math.floor(n / 100)]} Hundred` : '', n % 100 ? two(n % 100) : ''].filter(Boolean).join(' ');
  const words = (n: number): string => {
    if (n === 0) return 'Zero';
    const parts: string[] = [];
    for (const [size, name] of [[10_000_000, 'Crore'], [100_000, 'Lakh'], [1000, 'Thousand']] as const) {
      if (n >= size) { parts.push(`${size === 10_000_000 ? words(Math.floor(n / size)) : two(Math.floor(n / size))} ${name}`); n %= size; }
    }
    if (n) parts.push(three(n));
    return parts.join(' ');
  };
  const rupees = Math.floor(paise / 100), p = paise % 100;
  return `Rupees ${words(rupees)}${p ? ` and ${two(p)} Paise` : ''} Only`;
}
