// What an order email shows (task 4.10), read from the order when the email is sent: items, totals, address, the
// usual delivery days, and for a guest who asked for it at checkout a set-password link signed now (never stored).
import { parseSetting } from '@artq/shared';
import type { Order, OrderItem, Prisma } from '@prisma/client';
import { signLink } from '../auth/tokens.js';
import type { EmailLinks } from './consumer.js';

export const firstName = (full: string) => full.trim().split(/\s+/)[0] || 'there';

export async function orderEmailData(tx: Prisma.TransactionClient, o: Order & { items: OrderItem[] }, payload: Record<string, unknown>, links: EmailLinks | undefined): Promise<Record<string, unknown>> {
  const ship = await tx.setting.findUnique({ where: { key: 'SHIPPING' } });
  const days = ship ? parseSetting('SHIPPING', ship.value).estimatedDays : { min: 4, max: 7 };
  const wantsLink = o.userId === null && (o.pricingSnapshot as { contact?: { sendSetPasswordLink?: boolean } } | null)?.contact?.sendSetPasswordLink === true;
  const hasPassword = wantsLink ? (await tx.user.findFirst({ where: { email: o.contactEmail, deletedAt: null, passwordHash: { not: null } }, select: { id: true } })) !== null : true;
  const refund = typeof payload.refund_id === 'number' ? await tx.refund.findUnique({ where: { id: payload.refund_id }, select: { amount: true } }) : null;
  const shipment = await tx.shipment.findUnique({ where: { orderId: o.id }, select: { courierName: true, awbNumber: true, trackingUrl: true } });
  const ret = typeof payload.return_id === 'number'
    ? await tx.returnRequest.findUnique({ where: { id: payload.return_id }, include: { items: { include: { orderItem: { select: { productName: true, variantLabel: true } } }, orderBy: { orderItemId: 'asc' } } } })
    : null;
  const lastPayment = payload.reason ? await tx.payment.findFirst({ where: { orderId: o.id, allocation: { in: ['EXCESS', 'LATE'] } }, orderBy: { id: 'desc' }, select: { amount: true } }) : null;
  return {
    orderNumber: o.orderNumber, firstName: firstName(o.shipName), paymentMethod: o.paymentMethod,
    lines: o.items.map((i) => ({ name: i.productName, label: i.variantLabel, quantity: i.quantity, total: i.lineTotal })),
    totals: { subtotal: o.subtotal, couponDiscount: o.couponDiscount, couponCode: o.couponCode, shipping: o.shippingFee, codFee: o.codFee, total: o.total },
    address: [o.shipName, o.shipLine1, ...(o.shipLine2 ? [o.shipLine2] : []), ...(o.shipLandmark ? [`Near ${o.shipLandmark}`] : []), `${o.shipCity}, ${o.shipState} ${o.shipPincode}`, `Phone ${o.shipPhone}`],
    estimate: `${days.min}–${days.max} days`,
    setPasswordLink: wantsLink && !hasPassword && links ? `${links.webUrl.replace(/\/$/, '')}/set-password?token=${signLink(links.linkSecret, 'set_password', { e: o.contactEmail.toLowerCase() }, links.setPasswordTtlS)}` : null,
    shipment: shipment ? { courier: shipment.courierName, awb: shipment.awbNumber, trackingUrl: shipment.trackingUrl } : null,
    refundAmount: refund?.amount ?? null,
    reason: payload.reason ?? null,
    amount: refund?.amount ?? lastPayment?.amount ?? o.total,
    return: ret ? {
      id: ret.id, reason: ret.reason, note: ret.adminNote,
      items: ret.items.map((i) => ({ name: i.orderItem.productName, label: i.orderItem.variantLabel, quantity: i.approvedQty ?? i.requestedQty, received: i.receivedQty })),
    } : null,
  };
}
