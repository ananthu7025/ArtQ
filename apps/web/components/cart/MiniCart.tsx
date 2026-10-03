'use client';
// Mini-cart drawer (product.md §5.7, design-system.md §5.8): opens after an add with the added item, the cart subtotal,
// free-shipping progress and VIEW CART / CHECKOUT. Right side, 420 px (full width on phones); focus-trapped, Esc and
// the close button close it (focus goes back to the control that added), and it closes when the page changes.
import { formatINR } from '@artq/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { CheckCircle2, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { Img, ImgPlaceholder } from '../Img';
import { useShop } from '../shop/ShopProvider';
import { FreeShippingProgress, itemsText } from './parts';

export function MiniCart() {
  const { miniCart, closeMiniCart, cart } = useShop();
  const pathname = usePathname();
  const open = miniCart !== null && miniCart.path === pathname;   // shown only on the page it was opened on
  const item = open && cart?.items.find((i) => i.variantId === miniCart.variantId);
  // The close handler runs after the state is cleared: keep where focus should go.
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => { if (miniCart) returnTo.current = miniCart.returnTo; }, [miniCart]);
  const button = 'flex h-12 flex-1 items-center justify-center rounded-md text-sm font-semibold uppercase tracking-[0.06em]';
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) closeMiniCart(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/40" />
        <Dialog.Content aria-describedby={undefined}
          onCloseAutoFocus={(e) => { const t = returnTo.current; if (t?.isConnected) { e.preventDefault(); t.focus(); } }}
          className="fixed inset-y-0 right-0 z-[61] flex w-full max-w-[420px] flex-col bg-white shadow-xl outline-none sm:w-[420px]">
          <div className="flex items-center justify-between border-b border-surface-200 px-5 py-4">
            <Dialog.Title className="flex items-center gap-2 text-lg font-semibold text-ink-900"><CheckCircle2 aria-hidden size={20} className="text-success-700" />Added to your cart</Dialog.Title>
            <Dialog.Close className="flex h-11 w-11 items-center justify-center rounded-md text-ink-900 hover:bg-surface-100" aria-label="Close"><X aria-hidden size={20} /></Dialog.Close>
          </div>
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
            {open && <p role="status" className="sr-only">Added {miniCart.quantity > 1 ? `${miniCart.quantity} × ` : ''}{miniCart.name} to your cart</p>}
            {item && (
              <div className="flex gap-4">
                <div className="h-20 w-20 shrink-0 overflow-hidden rounded-md bg-surface-100">
                  {item.image ? <Img media={item.image} sizes="80px" className="h-full w-full object-cover" alt="" /> : <ImgPlaceholder className="h-full w-full" />}
                </div>
                <div className="min-w-0 text-sm">
                  <p className="font-medium text-ink-900">{item.productName}</p>
                  <p className="text-ink-700">{item.variantLabel}</p>
                  <p className="mt-1 text-ink-900">{item.quantity} × {formatINR(item.unitPrice)}{item.quantity > 1 && <span className="text-ink-700"> = {formatINR(item.lineTotal)}</span>}</p>
                </div>
              </div>
            )}
            {cart && (
              <>
                <p className="flex justify-between border-t border-surface-200 pt-4 text-sm text-ink-900">
                  <span>Cart subtotal ({itemsText(cart.totals.itemCount)})</span>
                  <span className="font-semibold">{formatINR(cart.totals.subtotal - cart.totals.couponDiscount)}</span>
                </p>
                <FreeShippingProgress totals={cart.totals} />
              </>
            )}
          </div>
          <div className="space-y-2 border-t border-surface-200 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
            <div className="flex gap-3">
              <Link href="/cart" onClick={closeMiniCart} className={`${button} border-[1.5px] border-ink-900 text-ink-900 hover:bg-ink-900 hover:text-white`}>View cart</Link>
              <Link href="/checkout" onClick={closeMiniCart} className={`${button} bg-brand-700 text-white hover:bg-brand-800`}>Checkout</Link>
            </div>
            <Dialog.Close className="h-11 w-full text-sm font-medium text-brand-700 underline underline-offset-2">Continue shopping</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
