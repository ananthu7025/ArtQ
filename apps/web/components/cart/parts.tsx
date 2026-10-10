// Pieces shared by the cart page and the mini-cart (product.md §5.5, §5.7).
import { formatINR, type CartView, type ShippingProblem } from '@artq/shared';
import { Truck } from 'lucide-react';

/** "Add ₹151 more for FREE shipping" with a bar; "You get FREE shipping" once eligible (after any coupon). */
export function FreeShippingProgress({ totals }: { totals: CartView['totals'] }) {
  if (totals.itemCount === 0) return null;
  const free = totals.shipping.freeApplied;
  const done = free ? 1 : Math.max(0, Math.min(1, 1 - totals.freeShippingRemaining / totals.freeShippingThreshold));
  return (
    <div className="rounded-md bg-brand-50 px-3 py-2.5 text-sm text-brand-800">
      <p className="flex items-center gap-2">
        <Truck aria-hidden size={16} className="shrink-0" />
        {free ? <span>You get <strong>FREE shipping</strong> on this order.</span> : <span>Add <strong>{formatINR(totals.freeShippingRemaining)}</strong> more for <strong>FREE shipping</strong>.</span>}
      </p>
      <div aria-hidden className="mt-2 h-1.5 overflow-hidden rounded-full bg-white">
        <div className="h-full rounded-full bg-brand-700 transition-[width] motion-reduce:transition-none" style={{ width: `${Math.round(done * 100)}%` }} />
      </div>
    </div>
  );
}

export const SHIPPING_PROBLEM: Record<ShippingProblem, string> = {
  UNKNOWN_PINCODE: 'We couldn’t find this pincode. Please check the number.',
  NO_ZONE: 'We don’t deliver to this area yet.',
  PINCODE_NOT_SERVICEABLE: 'Sorry, we don’t deliver to this pincode yet.',
  SHIPPING_RESTRICTED: 'Some items (like resin) travel by road only and can’t be delivered to this pincode.',
  DIMENSIONS_REQUIRED: 'We can’t work out shipping for one of these items yet. Please contact us.',
  NO_RATE: 'This order is too heavy for our usual rates. Please contact us.',
};

export const itemsText = (n: number) => `${n} item${n === 1 ? '' : 's'}`;
