'use client';
// What the customer sees after Place order (product.md §5.6 "Payment behaviour"): paying, confirming, "Payment
// processing: we're confirming with your bank" (polled for up to 2 minutes, then "we'll email you"), "Payment didn't go
// through" with Retry payment and Switch to COD, held for review, refunded, expired.
import { formatINR } from '@artq/shared';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { primaryButton, secondaryButton } from '../form/fields';
import type { FlowState } from './useCheckoutFlow';

export function FlowPanel({ state, retry, codAllowed = true, codFee = 0 }: { state: Exclude<FlowState, { step: 'idle' | 'placing' }>; retry: (orderNumber: string, method: 'RAZORPAY' | 'COD') => Promise<void>; codAllowed?: boolean; codFee?: number }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { heading.current?.focus(); }, [state.step]);
  const run = (m: 'RAZORPAY' | 'COD') => { setBusy(true); void retry(state.orderNumber, m).finally(() => setBusy(false)); };
  const box = 'mx-auto max-w-xl rounded-lg border border-surface-200 p-6 text-center md:p-8';
  const h = (text: string) => <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold text-ink-900 outline-none">{text}</h2>;
  const order = <p className="mt-1 text-sm text-ink-700">Order <strong className="font-mono text-ink-900">{state.orderNumber}</strong></p>;
  switch (state.step) {
    case 'paying':
      return <div role="status" className={box}>{h('Complete your payment')}{order}<p className="mt-3 text-ink-700">Finish paying in the Razorpay window. Your items are held for 30 minutes.</p></div>;
    case 'verifying':
      return <div role="status" className={box}>{h('Confirming your payment…')}{order}</div>;
    case 'processing':
      return (
        <div role="status" className={box}>
          {h(state.gaveUp ? 'We’re still confirming your payment' : 'Payment processing')}{order}
          <p className="mt-3 text-ink-700">{state.gaveUp
            ? 'This is taking longer than usual. We’ll email you as soon as your bank confirms. You don’t need to pay again.'
            : 'We’re confirming with your bank. This usually takes a few seconds; please keep this page open.'}</p>
          {state.gaveUp && <Link href="/" className={`${secondaryButton} mt-6`}>Continue shopping</Link>}
        </div>
      );
    case 'failed':
      return (
        <div role="alert" className={box}>
          {h('Payment didn’t go through')}{order}
          <p className="mt-3 text-ink-700">{state.reason} No money was taken; if any was, it is refunded automatically. Your items are held for a little longer.</p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <button type="button" disabled={busy} onClick={() => run('RAZORPAY')} className={primaryButton}>{busy ? 'Please wait…' : 'Retry payment'}</button>
            {codAllowed && <button type="button" disabled={busy} onClick={() => run('COD')} className={secondaryButton}>Switch to cash on delivery{codFee ? ` (+ ${formatINR(codFee)})` : ''}</button>}
          </div>
        </div>
      );
    case 'review':
      return <div role="status" className={box}>{h('We’re checking your payment')}{order}<p className="mt-3 text-ink-700">Your payment reached us, but it needs a quick check before we confirm the order. We’ll email you shortly.</p><Link href="/" className={`${secondaryButton} mt-6`}>Continue shopping</Link></div>;
    case 'refunded':
      return <div role="alert" className={box}>{h('Your payment was refunded')}{order}<p className="mt-3 text-ink-700">The payment was refunded before we could confirm the order, so it wasn’t placed. Your cart is still here.</p><Link href="/cart" className={`${primaryButton} mt-6`}>Back to your cart</Link></div>;
    case 'expired':
      return <div role="alert" className={box}>{h('This order has expired')}{order}<p className="mt-3 text-ink-700">It wasn’t paid within the time the items were held. If you paid, the money is refunded in full. You can order again from your cart.</p><Link href="/cart" className={`${primaryButton} mt-6`}>Back to your cart</Link></div>;
    case 'placed':
      return <div role="status" className={box}>{h('Order placed')}{order}</div>;
  }
}
