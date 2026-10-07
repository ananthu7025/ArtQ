// Dispatch and invoices (task 5.2; database.md §8.4, architecture.md §10.4). Ship = one call to aq_dispatch_order with
// the invoice content computed here by the shared tax rules (buildInvoiceContent): stock consumed, invoice numbered
// and stored, shipment recorded, PACKED → SHIPPED, "shipped" email and the invoice PDF job, in one transaction.
// The PDF is rendered from the stored invoice row and kept as PRIVATE media; `pdf_media_id` is set once (trigger).
// Staff get a 5-minute signed link (rendering it first if the worker has not yet).
import { randomUUID } from 'node:crypto';
import { buildInvoiceContent, parseSetting, type InvoiceParty, type shipOrderBody, type ShippingTaxRule } from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { z } from 'zod';
import * as fn from '../db/functions.js';
import { DbFunctionError } from '../db/errors.js';
import { AppError } from '../lib/errors.js';
import type { MediaConfig } from '../media/service.js';
import { loadDelivery } from '../outbox/consume.js';
import type { Actor } from './admin-service.js';
import { describe } from './admin-service.js';
import { renderInvoicePdf } from './invoice-pdf.js';

export const INVOICE_URL_TTL_S = 300;

export class DispatchService {
  constructor(private readonly prisma: PrismaClient, private readonly media: Pick<MediaConfig, 'store' | 'buckets'>, private readonly now: () => Date = () => new Date()) {}

  /** The invoice content for a packed order, from its snapshot lines, the store details and the D-3 rule. */
  async invoiceFor(orderId: number) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId }, include: { items: { orderBy: { id: 'asc' } } } });
    if (!o) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    const [storeRow, taxRow, shipState] = await Promise.all([
      this.prisma.setting.findUnique({ where: { key: 'STORE_INFO' } }),
      this.prisma.setting.findUnique({ where: { key: 'TAX' } }),
      o.shipStateCode ? null : this.prisma.state.findFirst({ where: { name: o.shipState }, select: { gstCode: true } }),
    ]);
    const store = storeRow ? parseSetting('STORE_INFO', storeRow.value) : null;
    const rule: ShippingTaxRule = taxRow ? parseSetting('TAX', taxRow.value).shippingTaxRule : 'CA_DECISION';
    const storeState = store?.stateCode ?? '32';
    const placeOfSupply = o.shipStateCode ?? shipState?.gstCode ?? null;
    if (!placeOfSupply) throw new AppError(422, 'INVALID_TRANSITION', `The delivery state “${o.shipState}” has no GST state code. Correct the address first.`);
    const seller: InvoiceParty = { name: store?.legalName ?? store?.name ?? 'ArtQ', lines: store?.address ? store.address.split(/\n|,\s*/).filter(Boolean) : [], stateCode: storeState, state: null, gstin: store?.gstin ?? null, phone: store?.phone ?? null, email: store?.email ?? null };
    const bill = !o.billSameAsShip && o.billingSnapshot ? (o.billingSnapshot as Record<string, string | null>) : null;
    const buyer: InvoiceParty = bill
      ? { name: o.businessName ?? bill.fullName ?? o.shipName, lines: [bill.line1, bill.line2, `${bill.city ?? ''}${bill.pincode ? ` ${bill.pincode}` : ''}`].filter((x): x is string => !!x), stateCode: bill.stateCode ?? null, state: bill.state ?? null, gstin: o.gstin }
      : { name: o.businessName ?? o.shipName, lines: [...(o.businessName ? [o.shipName] : []), o.shipLine1, ...(o.shipLine2 ? [o.shipLine2] : []), `${o.shipCity} ${o.shipPincode}`], stateCode: placeOfSupply, state: o.shipState, gstin: o.gstin };
    return buildInvoiceContent(
      { items: o.items.map((i) => ({ name: i.productName, label: i.variantLabel, sku: i.sku, hsn: i.hsnCode, quantity: i.quantity, net: i.netAmount, ratePercent: Number(i.taxRate) })), shippingFee: o.shippingFee, codFee: o.codFee, total: o.total },
      { seller, buyer, placeOfSupply, storeStateCode: storeState, shippingTaxRule: rule, at: this.now() },
    );
  }

  async ship(orderId: number, b: z.output<typeof shipOrderBody>, actor: Actor) {
    const invoice = await this.invoiceFor(orderId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const r = await fn.dispatchOrder(tx, { orderId, courier: b.courierName, awb: b.awbNumber, trackingUrl: b.trackingUrl, weightG: b.weightG, invoice, notify: b.notifyCustomer, actorId: actor.userId });
        await actor.audit(tx, { action: 'order.ship', entity: 'order', entityId: orderId, after: { courier: b.courierName, awb: b.awbNumber, invoice: r.invoice_number, notifyCustomer: b.notifyCustomer } });
        return r;
      }, { timeout: 30_000 });
    } catch (e) {
      if (e instanceof DbFunctionError && e.code === 'AWB_IN_USE') throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'awbNumber', message: `This AWB number is already used for another ${b.courierName} shipment` }]);
      if (e instanceof DbFunctionError && e.code === 'INVALID_TRANSITION') {
        const o = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, paymentStatus: true, fulfilmentStatus: true } });
        throw new AppError(422, 'INVALID_TRANSITION', `This order can’t be shipped now: it is ${describe(o)}. Reload to see its latest state.`, { current: o });
      }
      throw e;
    }
  }

  /** The stored PDF of an invoice, rendering and storing it once if needed. Safe to call concurrently. */
  async ensurePdf(invoiceId: number): Promise<number> {
    const inv = await this.prisma.invoice.findUnique({ where: { id: invoiceId }, include: { order: { select: { orderNumber: true } } } });
    if (!inv) throw new AppError(404, 'NOT_FOUND', 'Invoice not found');
    if (inv.pdfMediaId) return inv.pdfMediaId;
    const pdf = await renderInvoicePdf(inv, inv.order.orderNumber);
    const key = `private/invoice/${inv.fy}/${inv.number.replace(/\//g, '-')}-${randomUUID()}.pdf`;
    await this.media.store.put(this.media.buckets.PRIVATE, key, pdf, 'application/pdf');
    const m = await this.prisma.media.create({ data: { key, visibility: 'PRIVATE', kind: 'DOCUMENT', declaredMime: 'application/pdf', detectedMime: 'application/pdf', declaredSize: pdf.length, sizeBytes: pdf.length, ownerScope: `invoice:${inv.orderId}`, status: 'READY', claimedAt: new Date() } });
    const set = await this.prisma.$executeRaw`UPDATE invoices SET pdf_media_id = ${m.id} WHERE id = ${invoiceId} AND pdf_media_id IS NULL`;
    if (set === 1) return m.id;
    await this.prisma.media.update({ where: { id: m.id }, data: { deletedAt: new Date() } });   // another render won the race
    return (await this.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { pdfMediaId: true } })).pdfMediaId!;
  }

  /** A short-lived link to the order's tax invoice PDF (orders:read). */
  async invoiceUrl(orderId: number): Promise<{ number: string; url: string }> {
    const inv = await this.prisma.invoice.findFirst({ where: { orderId, kind: 'TAX_INVOICE' }, select: { id: true, number: true } });
    if (!inv) throw new AppError(404, 'NOT_FOUND', 'This order has no invoice yet. It is issued when the order ships.');
    const media = await this.prisma.media.findUniqueOrThrow({ where: { id: await this.ensurePdf(inv.id) } });
    const url = await this.media.store.presignGet(this.media.buckets.PRIVATE, media.key, { expiresIn: INVOICE_URL_TTL_S, attachmentName: `invoice-${inv.number.replace(/\//g, '-')}.pdf` });
    return { number: inv.number, url };
  }
}

/** Outbox consumer `invoice.render`: renders and stores the PDF of a newly issued invoice, then completes the delivery. */
export async function processInvoiceRender(d: { prisma: PrismaClient; dispatch: DispatchService; log: Logger }, deliveryId: number): Promise<'DONE' | 'ALREADY_DONE'> {
  const ev = await d.prisma.$transaction(async (tx) => ((await fn.outboxBeginConsume(tx, deliveryId)) ? loadDelivery(tx, deliveryId) : null));
  if (!ev) return 'ALREADY_DONE';
  const invoiceId = Number((ev.payload as { invoice_id?: unknown } | null)?.invoice_id);
  if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) throw new TypeError(`invoice.render event ${ev.eventId} has no invoice_id`);
  await d.dispatch.ensurePdf(invoiceId);
  await d.prisma.$transaction(async (tx) => { if (await fn.outboxBeginConsume(tx, deliveryId)) await fn.outboxComplete(tx, deliveryId); });
  return 'DONE';
}
