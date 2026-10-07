// Packing slip (task 5.1; architecture.md §3 PDF, product.md §7.5): what goes in the box and where it goes. Built on
// request from the order as it is now (so a corrected address prints correctly) and never stored; it is not a tax
// document (the invoice is issued at dispatch, task 5.2). No prices except the cash to collect on a COD order.
import type { SettingValue } from '@artq/shared';
import type { Order, OrderItem } from '@prisma/client';
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer';
import { pdfINR } from './invoice-pdf.js';

const s = StyleSheet.create({
  page: { padding: 36, fontSize: 10, fontFamily: 'Helvetica', color: '#111827' },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  store: { fontSize: 16, fontFamily: 'Helvetica-Bold' },
  muted: { color: '#4b5563' },
  h: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: '#4b5563', textTransform: 'uppercase', marginBottom: 4, letterSpacing: 0.5 },
  box: { borderWidth: 1, borderColor: '#d1d5db', borderRadius: 4, padding: 10 },
  big: { fontSize: 12, fontFamily: 'Helvetica-Bold' },
  th: { flexDirection: 'row', borderBottomWidth: 1, borderColor: '#111827', paddingBottom: 4, fontFamily: 'Helvetica-Bold' },
  tr: { flexDirection: 'row', borderBottomWidth: 0.5, borderColor: '#d1d5db', paddingVertical: 6 },
  check: { width: 18 }, item: { flex: 1 }, sku: { width: 120 }, qty: { width: 40, textAlign: 'right' },
  cod: { marginTop: 12, padding: 10, backgroundColor: '#fef3c7', fontFamily: 'Helvetica-Bold', fontSize: 12 },
});

const date = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

export function renderPackingSlip(o: Order & { items: OrderItem[] }, store: SettingValue<'STORE_INFO'> | null): Promise<Buffer> {
  const units = o.items.reduce((n, i) => n + i.quantity, 0);
  const address = [o.shipLine1, o.shipLine2, o.shipLandmark ? `Near ${o.shipLandmark}` : null, `${o.shipCity}, ${o.shipState} ${o.shipPincode}`].filter(Boolean) as string[];
  return renderToBuffer(
    <Document title={`Packing slip ${o.orderNumber}`} author={store?.name ?? 'ArtQ'}>
      <Page size="A4" style={s.page}>
        <View style={s.row}>
          <View>
            <Text style={s.store}>{store?.name ?? 'ArtQ'}</Text>
            {store?.address && <Text style={s.muted}>{store.address}</Text>}
            {store?.phone && <Text style={s.muted}>{store.phone}</Text>}
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={s.big}>Packing slip</Text>
            <Text>Order {o.orderNumber}</Text>
            <Text style={s.muted}>Placed {date(o.placedAt ?? o.createdAt)}</Text>
          </View>
        </View>

        <View style={[s.row, { marginTop: 20, gap: 12 }]}>
          <View style={[s.box, { flex: 1 }]}>
            <Text style={s.h}>Ship to</Text>
            <Text style={s.big}>{o.shipName}</Text>
            {address.map((l, i) => <Text key={i}>{l}</Text>)}
            <Text>Phone {o.shipPhone}</Text>
          </View>
          <View style={[s.box, { width: 170 }]}>
            <Text style={s.h}>Parcel</Text>
            <Text>{units} item{units === 1 ? '' : 's'}</Text>
            <Text>Weight about {(o.chargeableWeightG / 1000).toLocaleString('en-IN', { maximumFractionDigits: 2 })} kg</Text>
            <Text>{o.paymentMethod === 'COD' ? 'Cash on delivery' : 'Prepaid'}</Text>
          </View>
        </View>

        <View style={{ marginTop: 20 }}>
          <View style={s.th}><Text style={s.check}> </Text><Text style={s.item}>Item</Text><Text style={s.sku}>SKU</Text><Text style={s.qty}>Qty</Text></View>
          {o.items.map((i) => (
            <View key={i.id} style={s.tr} wrap={false}>
              <Text style={s.check}>[ ]</Text>
              <Text style={s.item}>{i.productName}{i.variantLabel ? ` (${i.variantLabel})` : ''}</Text>
              <Text style={s.sku}>{i.sku}</Text>
              <Text style={s.qty}>{i.quantity}</Text>
            </View>
          ))}
        </View>

        {o.paymentMethod === 'COD' && <Text style={s.cod}>Collect {pdfINR(o.total)} on delivery</Text>}
        {o.customerNote && <View style={[s.box, { marginTop: 12 }]}><Text style={s.h}>Customer note</Text><Text>{o.customerNote}</Text></View>}
        <Text style={[s.muted, { marginTop: 24 }]}>Thank you for shopping with {store?.name ?? 'ArtQ'}.</Text>
      </Page>
    </Document>,
  );
}
