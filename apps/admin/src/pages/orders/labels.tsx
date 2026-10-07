// Words and colours for the four order status dimensions (database.md §3.9), shared by the Orders list and detail.
import type { FulfilmentStatusValue, OrderPaymentStatusValue, OrderStatusValue, ReturnStatusValue } from '@artq/shared';

type Tone = 'good' | 'wait' | 'bad' | 'plain' | 'info';
const TONE: Record<Tone, string> = {
  good: 'bg-[#dcfce7] text-success-700', wait: 'bg-warning-bg text-warning-ink', bad: 'bg-[#fee2e2] text-danger-700',
  plain: 'bg-surface-100 text-ink-700', info: 'bg-[#e0f2fe] text-[#075985]',
};

export const ORDER_LABEL: Record<OrderStatusValue, [string, Tone]> = {
  PENDING_PAYMENT: ['Awaiting payment', 'wait'], PLACED: ['Placed', 'info'], CONFIRMED: ['Confirmed', 'good'], COMPLETED: ['Completed', 'plain'],
  CANCELLED: ['Cancelled', 'bad'], EXPIRED: ['Expired', 'plain'],
};
export const PAYMENT_LABEL: Record<OrderPaymentStatusValue, [string, Tone]> = {
  UNPAID: ['Unpaid', 'plain'], PROCESSING: ['Payment processing', 'wait'], PAID: ['Paid', 'good'], PARTIALLY_REFUNDED: ['Partly refunded', 'wait'],
  REFUNDED: ['Refunded', 'plain'], COD_PENDING: ['COD: to collect', 'info'], COD_COLLECTED: ['COD: collected', 'good'], COD_REMITTED: ['COD: remitted', 'good'],
  NOT_COLLECTED: ['COD: not collected', 'bad'],
};
export const FULFILMENT_LABEL: Record<FulfilmentStatusValue, [string, Tone]> = {
  UNFULFILLED: ['Not packed', 'plain'], PACKED: ['Packed', 'info'], SHIPPED: ['Shipped', 'info'], OUT_FOR_DELIVERY: ['Out for delivery', 'info'],
  DELIVERED: ['Delivered', 'good'], RTO_IN_TRANSIT: ['Returning to us', 'bad'], RTO_RECEIVED: ['Returned to us', 'bad'], LOST: ['Lost', 'bad'],
};
export const RETURN_LABEL: Record<ReturnStatusValue, [string, Tone]> = { NONE: ['No return', 'plain'], OPEN: ['Return open', 'wait'], CLOSED: ['Return closed', 'plain'] };

export function Pill({ label }: { label: [string, Tone] }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE[label[1]]}`}>{label[0]}</span>;
}

export const dateTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
export const when = (iso: string) => dateTime.format(new Date(iso));
