// Storefront analytics (architecture.md §3 `lib/analytics`). Events go to `window.dataLayer` in the GA4 ecommerce shape,
// so a tag manager added later picks them up without code changes. `purchase` is sent once per order per browser
// (product.md §5.8): a reload, the back button or a second tab never counts the sale twice.
import type { OrderConfirmation } from '@artq/shared';

type DataLayer = { push: (e: Record<string, unknown>) => unknown };
const SENT_KEY = 'aq_purchase_sent';

function sentOrders(): string[] {
  try { const v = JSON.parse(window.localStorage.getItem(SENT_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}

/** Sends `purchase` for a PLACED order (the only status that counts as a sale), once. Returns whether it was sent. */
export function trackPurchase(o: OrderConfirmation): boolean {
  if (typeof window === 'undefined' || o.status !== 'PLACED') return false;
  const sent = sentOrders();
  if (sent.includes(o.orderNumber)) return false;
  try { window.localStorage.setItem(SENT_KEY, JSON.stringify([...sent, o.orderNumber].slice(-50))); } catch { /* storage off: still send once for this page */ }
  const w = window as unknown as { dataLayer?: DataLayer };
  (w.dataLayer ??= [] as unknown as DataLayer).push({
    event: 'purchase',
    ecommerce: {
      transaction_id: o.orderNumber, currency: 'INR', value: o.totals.total / 100, shipping: o.totals.shipping / 100,
      ...(o.totals.couponCode ? { coupon: o.totals.couponCode } : {}),
      payment_type: o.paymentMethod === 'COD' ? 'cod' : 'online',
      items: o.items.map((i) => ({ item_name: i.name, item_variant: i.label, quantity: i.quantity, price: i.lineTotal / i.quantity / 100 })),
    },
  });
  return true;
}
