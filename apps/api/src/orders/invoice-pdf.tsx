// Tax invoice PDF (task 5.2; architecture.md §10.4): rendered from the stored, immutable invoice row only, so a
// re-render always gives the same document. Seller and buyer with GSTIN and state code, place of supply, per line
// HSN, quantity, taxable value, rate and CGST+SGST or IGST, totals, rounding adjustment, amount in words.
// Format, rates and HSN codes still need the accountant's approval (task 7.5).
import { amountInWords, type InvoiceLine, type InvoiceParty } from '@artq/shared';
import type { Invoice } from '@prisma/client';
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer';

const s = StyleSheet.create({
  page: { padding: 32, fontSize: 9, fontFamily: 'Helvetica', color: '#111827' },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  title: { fontSize: 15, fontFamily: 'Helvetica-Bold' },
  bold: { fontFamily: 'Helvetica-Bold' },
  muted: { color: '#4b5563' },
  h: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#4b5563', textTransform: 'uppercase', marginBottom: 3, letterSpacing: 0.4 },
  box: { borderWidth: 1, borderColor: '#d1d5db', padding: 8, flex: 1 },
  th: { flexDirection: 'row', backgroundColor: '#f3f4f6', borderBottomWidth: 1, borderColor: '#9ca3af', paddingVertical: 4, fontFamily: 'Helvetica-Bold' },
  tr: { flexDirection: 'row', borderBottomWidth: 0.5, borderColor: '#d1d5db', paddingVertical: 4 },
  c1: { flex: 1, paddingHorizontal: 3 }, c: { width: 52, textAlign: 'right', paddingHorizontal: 3 }, cs: { width: 40, textAlign: 'right', paddingHorizontal: 3 },
});
/** The built-in PDF fonts have no ₹ glyph, so amounts read "Rs. 1,108.00". */
export const pdfINR = (p: number) => `Rs. ${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const inr = pdfINR;
const date = (d: Date) => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

function Party({ title, p, hideGstin = false }: { title: string; p: InvoiceParty; hideGstin?: boolean }) {
  return (
    <View style={s.box}>
      <Text style={s.h}>{title}</Text>
      <Text style={s.bold}>{p.name}</Text>
      {p.lines.map((l, i) => <Text key={i}>{l}</Text>)}
      {p.state && <Text>State: {p.state}{p.stateCode ? ` (${p.stateCode})` : ''}</Text>}
      {(!hideGstin || p.gstin) && <Text>GSTIN: {p.gstin ?? (title === 'Seller' ? 'not set' : 'unregistered')}</Text>}
    </View>
  );
}

/**
 * True when no GST was charged on this document: every line is at 0 % and every tax total is zero. A seller who is not
 * registered for GST may not issue a tax invoice, so such a document is a "Bill of supply" with no HSN, rate or tax columns.
 * Decided from the stored invoice row only, so a re-render never changes an issued document.
 */
export function isTaxFree(inv: Pick<Invoice, 'cgstTotal' | 'sgstTotal' | 'igstTotal'>, lines: Pick<InvoiceLine, 'ratePercent'>[]): boolean {
  return inv.cgstTotal === 0 && inv.sgstTotal === 0 && inv.igstTotal === 0 && lines.every((l) => Number(l.ratePercent) === 0);
}

/** A tax invoice (or bill of supply when no GST is charged), or a credit note (task 5.4) that names the document it corrects. */
export function renderInvoicePdf(inv: Invoice, orderNumber: string, originalNumber: string | null = null): Promise<Buffer> {
  const credit = inv.kind === 'CREDIT_NOTE';
  const seller = inv.sellerSnapshot as unknown as InvoiceParty;
  const buyer = inv.buyerSnapshot as unknown as InvoiceParty;
  const lines = inv.lines as unknown as InvoiceLine[];
  const intra = inv.igstTotal === 0;
  const noTax = isTaxFree(inv, lines);
  const kind = noTax ? 'Bill of supply' : 'Tax invoice';
  return renderToBuffer(
    <Document title={`${credit ? 'Credit note' : kind} ${inv.number}`} author={seller.name}>
      <Page size="A4" style={s.page}>
        <View style={s.row}>
          <View><Text style={s.title}>{credit ? 'Credit note' : kind}</Text><Text style={s.muted}>{credit ? `Against ${kind.toLowerCase()} ${originalNumber ?? ''}` : 'Original for recipient'}</Text></View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={s.bold}>{inv.number}</Text>
            <Text>Date {date(inv.issuedAt)}</Text>
            <Text>Order {orderNumber}</Text>
            <Text>Place of supply: {buyer.state ?? ''} ({inv.placeOfSupply})</Text>
          </View>
        </View>
        <View style={[s.row, { marginTop: 14, gap: 10 }]}><Party title="Seller" p={seller} hideGstin={noTax} /><Party title="Bill to / ship to" p={buyer} hideGstin={noTax} /></View>

        <View style={{ marginTop: 14 }}>
          <View style={s.th}>
            <Text style={s.c1}>Description</Text>{!noTax && <Text style={s.cs}>HSN</Text>}<Text style={s.cs}>Qty</Text>
            {!noTax && <><Text style={s.c}>Taxable</Text><Text style={s.cs}>Rate</Text>{intra ? <><Text style={s.c}>CGST</Text><Text style={s.c}>SGST</Text></> : <Text style={s.c}>IGST</Text>}</>}
            <Text style={s.c}>Amount</Text>
          </View>
          {lines.map((l, i) => (
            <View key={i} style={s.tr} wrap={false}>
              <Text style={s.c1}>{l.description}{l.sku ? `\n${l.sku}` : ''}</Text>{!noTax && <Text style={s.cs}>{l.hsn ?? ''}</Text>}<Text style={s.cs}>{l.quantity}</Text>
              {!noTax && <><Text style={s.c}>{inr(l.taxable)}</Text><Text style={s.cs}>{l.ratePercent}%</Text>
                {intra ? <><Text style={s.c}>{inr(l.cgst)}</Text><Text style={s.c}>{inr(l.sgst)}</Text></> : <Text style={s.c}>{inr(l.igst)}</Text>}</>}
              <Text style={s.c}>{inr(l.net)}</Text>
            </View>
          ))}
        </View>

        <View style={{ marginTop: 10, marginLeft: 'auto', width: 220 }}>
          {[...(noTax ? [] : [['Taxable value', inv.taxableTotal], ...(intra ? [['CGST', inv.cgstTotal], ['SGST', inv.sgstTotal]] : [['IGST', inv.igstTotal]])]), ...(inv.roundingAdjustment ? [['Rounding', inv.roundingAdjustment]] : [])].map(([k, v]) => (
            <View key={String(k)} style={s.row}><Text>{k}</Text><Text>{inr(Number(v))}</Text></View>
          ))}
          <View style={[s.row, { borderTopWidth: 1, borderColor: '#111827', marginTop: 3, paddingTop: 3 }]}><Text style={s.bold}>Total</Text><Text style={s.bold}>{inr(inv.grandTotal)}</Text></View>
        </View>
        <Text style={{ marginTop: 8 }}>{amountInWords(inv.grandTotal)}</Text>
        <Text style={[s.muted, { marginTop: 18 }]}>
          {noTax ? 'The seller is not registered under GST; no tax is charged.' : credit ? 'Amounts refunded include GST.' : 'Prices include GST.'} This is a computer-generated document and needs no signature.
        </Text>
      </Page>
    </Document>,
  );
}
