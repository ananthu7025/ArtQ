// The customer's view of their orders (task 5.7; api.md §3.5–3.6, product.md §5.10 and §8.5). One view for the
// signed-in owner, the guest with order access and the read-only tracking link; what each may do is in `actions`
// (the endpoints check again). Tracking masks the address and shows no photos.
import { customerDisplayStatus, maskContact, parseSetting, type CustomerOrderSummary, type CustomerOrderView, type customerOrderListQuery } from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import type { z } from 'zod';
import { AppError } from '../lib/errors.js';

export type Access = CustomerOrderView['access'];
/** Signed link for a private return photo, or null when this viewer may not see it. */
export type PhotoLink = (mediaId: number) => Promise<string | null>;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const LABEL: Record<string, Record<string, string>> = {
  ORDER: { PLACED: 'Order placed', CONFIRMED: 'Order confirmed', COMPLETED: 'Completed', CANCELLED: 'Order cancelled', EXPIRED: 'Payment not completed' },
  PAYMENT: { PAID: 'Payment received', COD_COLLECTED: 'Paid in cash', PARTIALLY_REFUNDED: 'Partly refunded', REFUNDED: 'Refunded' },
  FULFILMENT: { PACKED: 'Packed', SHIPPED: 'Shipped', OUT_FOR_DELIVERY: 'Out for delivery', DELIVERED: 'Delivered', RTO_IN_TRANSIT: 'Coming back to us', RTO_RECEIVED: 'Returned to us', LOST: 'Lost by the courier' },
  RETURN: { OPEN: 'Return requested', CLOSED: 'Return closed' },
};

export class CustomerOrderService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(userId: number, q: z.output<typeof customerOrderListQuery>) {
    const where = { userId, status: { not: 'PENDING_PAYMENT' as const } };
    const [total, rows] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({ where, include: { items: { orderBy: { id: 'asc' }, select: { productName: true, imageUrl: true, quantity: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    const data: CustomerOrderSummary[] = rows.map((o) => ({
      orderNumber: o.orderNumber, createdAt: o.createdAt.toISOString(), displayStatus: customerDisplayStatus(o), total: o.total,
      itemCount: o.items.reduce((n, i) => n + i.quantity, 0), firstItem: o.items[0] ? { name: o.items[0].productName, imageUrl: o.items[0].imageUrl } : null,
    }));
    return { data, meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) } };
  }

  async view(orderId: number, access: Access, photo: PhotoLink, now = new Date()): Promise<CustomerOrderView> {
    const o = await this.prisma.order.findUnique({ where: { id: orderId }, include: {
      items: { orderBy: { id: 'asc' } }, shipment: true, refunds: { orderBy: { id: 'asc' } }, invoices: { where: { kind: 'TAX_INVOICE' }, select: { id: true } },
      history: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      returns: { orderBy: { id: 'asc' }, include: { items: { include: { orderItem: { select: { productName: true } } } }, media: { select: { mediaId: true } } } },
    } });
    if (!o) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    const tracking = access === 'tracking';
    const setting = await this.prisma.setting.findUnique({ where: { key: 'ORDER' } });
    const windowH = setting ? parseSetting('ORDER', setting.value).returnWindowHours : 48;
    const delivered = o.fulfilmentStatus === 'DELIVERED' ? o.shipment?.deliveredAt ?? null : null;
    const deadline = delivered ? new Date(delivered.getTime() + windowH * 3_600_000) : null;
    const returnable = (i: { quantity: number; returnRequestedQty: number }) => Math.max(0, i.quantity - i.returnRequestedQty);
    const canReturn = !tracking && deadline !== null && now <= deadline && ['CONFIRMED', 'COMPLETED'].includes(o.status) && o.items.some((i) => returnable(i) > 0);
    const a = o.shipLine2 ? [o.shipLine1, o.shipLine2] : [o.shipLine1];
    const place = `${o.shipCity}, ${o.shipState} ${o.shipPincode}`;
    return {
      access, orderNumber: o.orderNumber, createdAt: o.createdAt.toISOString(), placedAt: iso(o.placedAt), displayStatus: customerDisplayStatus(o),
      status: o.status, paymentStatus: o.paymentStatus, fulfilmentStatus: o.fulfilmentStatus, returnStatus: o.returnStatus, paymentMethod: o.paymentMethod,
      items: o.items.map((i) => ({ id: i.id, name: i.productName, label: i.variantLabel, imageUrl: i.imageUrl, unitPrice: i.unitPrice, quantity: i.quantity, lineTotal: i.lineTotal, returnableQty: canReturn ? returnable(i) : 0 })),
      totals: { subtotal: o.subtotal, couponDiscount: o.couponDiscount, couponCode: o.couponCode, shipping: o.shippingFee, codFee: o.codFee, total: o.total, refunded: o.refundedAmount },
      // The tracking link may be forwarded: it shows where the parcel goes, not who lives there.
      shippingAddress: tracking
        ? { name: o.shipName.trim().split(/\s+/)[0] ?? '', lines: [place], phone: maskContact(o.shipPhone) }
        : { name: o.shipName, lines: [...a, ...(o.shipLandmark ? [`Near ${o.shipLandmark}`] : []), place], phone: o.shipPhone },
      shipment: o.shipment ? { courierName: o.shipment.courierName, awbNumber: o.shipment.awbNumber, trackingUrl: o.shipment.trackingUrl, shippedAt: iso(o.shipment.shippedAt), deliveredAt: iso(o.shipment.deliveredAt) } : null,
      timeline: o.history.flatMap((h) => { const label = LABEL[h.dimension]?.[h.toValue]; return label ? [{ label, at: h.createdAt.toISOString() }] : []; }),
      refunds: o.refunds.filter((r) => r.status !== 'CANCELLED' && r.itemsAmount + r.shippingAmount + r.codFeeAmount > 0)
        .map((r) => ({ amount: r.amount, status: r.status === 'PROCESSED' ? 'Refunded' : r.status === 'FAILED' ? 'Being retried' : 'On its way', createdAt: r.createdAt.toISOString(), processedAt: iso(r.processedAt) })),
      returns: await Promise.all(o.returns.map(async (r) => ({
        id: r.id, status: r.status, reason: r.reason, createdAt: r.createdAt.toISOString(),
        note: ['APPROVED', 'REJECTED'].includes(r.status) ? r.adminNote : null,      // the decision note was emailed to them; later notes are staff-only
        items: r.items.map((i) => ({ orderItemId: i.orderItemId, name: i.orderItem.productName, quantity: i.approvedQty ?? i.requestedQty })),
        photos: tracking ? [] : (await Promise.all(r.media.map(async (m) => { const url = await photo(m.mediaId); return url ? { id: m.mediaId, url } : null; }))).filter((x): x is { id: number; url: string } => x !== null),
      }))),
      returnDeadline: iso(deadline),
      actions: {
        canCancel: !tracking && (o.status === 'PENDING_PAYMENT' || (['PLACED', 'CONFIRMED'].includes(o.status) && o.fulfilmentStatus === 'UNFULFILLED')),
        canRetryPayment: !tracking && o.status === 'PENDING_PAYMENT',
        canRequestReturn: canReturn,
        canDownloadInvoice: !tracking && o.invoices.length > 0,
      },
    };
  }
}
