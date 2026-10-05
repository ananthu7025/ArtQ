'use client';
// The confirmation page (product.md §5.8): "Thank you, Hema! Order AQ10234 placed." with the items, totals, payment
// method, address and delivery estimate; guests can ask for a "Set a password" link. An order still waiting for the bank
// shows "Payment processing" and polls the status (3 s, up to 2 minutes). Analytics `purchase` fires once, only for PLACED.
import { formatINR, type CheckoutStatus, type OrderConfirmation } from '@artq/shared';
import { CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import { trackPurchase } from '../../lib/analytics';
import { useAuth } from '../account/AuthProvider';
import { ImgPlaceholder } from '../Img';
import { primaryButton, secondaryButton } from '../form/fields';
import { errorText, useApi } from '../shop/ShopProvider';
import { POLL_FOR_MS, POLL_MS } from './useCheckoutFlow';

type View = { kind: 'loading' } | { kind: 'missing' } | { kind: 'error' } | { kind: 'order'; order: OrderConfirmation };
const DONE = ['PLACED', 'CONFIRMED', 'COMPLETED'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function OrderPlacedView({ orderNumber, pollMs = POLL_MS, pollForMs = POLL_FOR_MS }: { orderNumber: string; pollMs?: number; pollForMs?: number }) {
  const api = useApi();
  const { status: auth } = useAuth();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [gaveUp, setGaveUp] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const path = `/checkout/orders/${encodeURIComponent(orderNumber)}`;

  const load = useCallback(async () => {
    try {
      const order = await api<OrderConfirmation>('GET', path);
      if (alive.current) setView({ kind: 'order', order });
      return order;
    } catch (e) {
      if (alive.current) setView({ kind: e instanceof ApiError && e.status === 404 ? 'missing' : 'error' });
      return null;
    }
  }, [api, path]);

  // Wait for the session: a signed-in customer's order is found by their account, not this browser's cart.
  useEffect(() => {
    if (auth === 'loading') return;
    void (async () => {
      const first = await load();
      if (first?.status !== 'PENDING_PAYMENT') return;
      const until = Date.now() + pollForMs;
      while (alive.current && Date.now() < until) {
        await sleep(pollMs);
        try {
          const s = await api<CheckoutStatus>('GET', `/checkout/status/${encodeURIComponent(orderNumber)}`);
          if (s.status !== 'PENDING_PAYMENT') { await load(); return; }
        } catch { /* keep polling */ }
      }
      if (alive.current) setGaveUp(true);
    })();
  }, [auth, load, api, orderNumber, pollMs, pollForMs]);

  useEffect(() => { if (view.kind === 'order') trackPurchase(view.order); }, [view]);

  const box = 'mx-auto w-full max-w-xl px-4 py-16 text-center';
  const order = <p className="mt-2 text-ink-700">Order <strong className="font-mono text-ink-900">{orderNumber}</strong></p>;
  const shop = <Link href="/shop" className={`${primaryButton} mt-8`}>Continue shopping</Link>;
  if (view.kind === 'loading') return <div role="status" className={box}><p className="text-ink-700">Loading your order…</p></div>;
  if (view.kind === 'missing') return (
    <div className={box}>
      <h1 className="font-display text-[28px] font-semibold text-ink-900">We couldn’t find this order</h1>{order}
      <p className="mt-3 text-ink-700">Order details open only in the browser or account that placed the order. Your confirmation email has everything.</p>{shop}
    </div>
  );
  if (view.kind === 'error') return (
    <div role="alert" className={box}>
      <h1 className="font-display text-[28px] font-semibold text-ink-900">We couldn’t load your order</h1>{order}
      <p className="mt-3 text-ink-700">Check your connection and try again. Your order is safe either way.</p>
      <button type="button" onClick={() => { setView({ kind: 'loading' }); void load(); }} className={`${primaryButton} mt-8`}>Try again</button>
    </div>
  );
  const o = view.order;
  if (o.status === 'PENDING_PAYMENT') return (
    <div role="status" className={box}>
      <h1 className="font-display text-[28px] font-semibold text-ink-900">{gaveUp ? 'We’re still confirming your payment' : 'Payment processing'}</h1>{order}
      <p className="mt-3 text-ink-700">{gaveUp
        ? `This is taking longer than usual. We’ll email ${o.contactEmail} as soon as your bank confirms. You don’t need to pay again.`
        : 'We’re confirming with your bank. This usually takes a few seconds; please keep this page open.'}</p>
      {gaveUp && <Link href="/shop" className={`${secondaryButton} mt-8`}>Continue shopping</Link>}
    </div>
  );
  if (!DONE.includes(o.status)) return (
    <div className={box}>
      <h1 className="font-display text-[28px] font-semibold text-ink-900">This order was not completed</h1>{order}
      <p className="mt-3 text-ink-700">The payment wasn’t completed in time, so the order was closed. If any money was taken, it is refunded automatically.</p>{shop}
    </div>
  );
  return <Placed o={o} guest={auth === 'anonymous'} />;
}

function Placed({ o, guest }: { o: OrderConfirmation; guest: boolean }) {
  const api = useApi();
  const heading = useRef<HTMLHeadingElement>(null);
  const [link, setLink] = useState<{ state: 'idle' | 'sending' | 'sent' } | { state: 'error'; message: string }>({ state: 'idle' });
  useEffect(() => { heading.current?.focus(); }, []);
  const sendLink = () => {
    setLink({ state: 'sending' });
    api('POST', `/checkout/orders/${encodeURIComponent(o.orderNumber)}/set-password-link`, {})
      .then(() => setLink({ state: 'sent' }), (e: unknown) => setLink({ state: 'error', message: errorText(e) }));
  };
  const t = o.totals;
  const row = (label: string, value: string, cls = 'text-ink-900') => <div className="flex justify-between gap-4"><dt className="text-ink-700">{label}</dt><dd className={`tabular-nums ${cls}`}>{value}</dd></div>;
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12 md:py-16">
      <div className="text-center">
        <CheckCircle2 aria-hidden size={48} className="mx-auto text-success-700" />
        <h1 ref={heading} tabIndex={-1} className="mt-4 font-display text-[28px] font-semibold text-ink-900 outline-none md:text-[34px]">Thank you, {o.firstName}! Your order is placed.</h1>
        <p className="mt-2 text-ink-700">Order <strong className="font-mono text-ink-900">{o.orderNumber}</strong>. We’ve emailed the confirmation to {o.contactEmail}, and we’ll email you again when it ships.</p>
      </div>

      <section aria-labelledby="items-h" className="mt-10 rounded-lg border border-surface-200 p-5 md:p-6">
        <h2 id="items-h" className="text-lg font-semibold text-ink-900">Your items</h2>
        <ul className="mt-4 flex flex-col gap-4">
          {o.items.map((i, n) => (
            <li key={n} className="flex items-center gap-4">
              <div className="size-16 shrink-0 overflow-hidden rounded-md">{i.imageUrl ? <img src={i.imageUrl} alt="" loading="lazy" className="size-full object-cover" /> : <ImgPlaceholder className="size-full" />}</div>
              <div className="min-w-0 flex-1"><p className="font-medium text-ink-900">{i.name}</p><p className="text-sm text-ink-700">{i.label} · Qty {i.quantity}</p></div>
              <p className="tabular-nums text-ink-900">{formatINR(i.lineTotal)}</p>
            </li>
          ))}
        </ul>
        <dl className="mt-5 flex flex-col gap-2 border-t border-surface-200 pt-4 text-sm">
          {row('Subtotal', formatINR(t.subtotal))}
          {t.couponDiscount > 0 && row(`Coupon ${t.couponCode ?? ''}`.trim(), `−${formatINR(t.couponDiscount)}`, 'text-success-700')}
          {row('Shipping', t.shipping === 0 ? 'FREE' : formatINR(t.shipping))}
          {t.codFee > 0 && row('Cash on delivery fee', formatINR(t.codFee))}
          <div className="flex justify-between gap-4 border-t border-surface-200 pt-2 text-base font-semibold"><dt className="text-ink-900">Total</dt><dd className="tabular-nums text-ink-900">{formatINR(t.total)}</dd></div>
        </dl>
      </section>

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <section aria-labelledby="pay-h" className="rounded-lg border border-surface-200 p-5">
          <h2 id="pay-h" className="font-semibold text-ink-900">Payment</h2>
          <p className="mt-2 text-sm text-ink-700">{o.paymentMethod === 'COD' ? `Cash on delivery: please keep ${formatINR(t.total)} ready.` : 'Paid online.'}</p>
          <h2 className="mt-4 font-semibold text-ink-900">Estimated delivery</h2>
          <p className="mt-2 text-sm text-ink-700">{o.estimatedDays.min}–{o.estimatedDays.max} days after dispatch</p>
        </section>
        <section aria-labelledby="addr-h" className="rounded-lg border border-surface-200 p-5">
          <h2 id="addr-h" className="font-semibold text-ink-900">Delivering to</h2>
          <address className="mt-2 text-sm not-italic text-ink-700"><span className="font-medium text-ink-900">{o.address.name}</span>{o.address.lines.map((l, n) => <span key={n} className="block">{l}</span>)}</address>
        </section>
      </div>

      {guest && o.canSetPassword && (
        <section aria-labelledby="pw-h" className="mt-6 rounded-lg bg-surface-100 p-5">
          <h2 id="pw-h" className="font-semibold text-ink-900">Track this and future orders</h2>
          <p className="mt-1 text-sm text-ink-700">Set a password and you can sign in with {o.contactEmail}. We’ll email you the link.</p>
          {link.state === 'sent'
            ? <p role="status" className="mt-3 text-sm font-medium text-success-700">Link sent. Check your inbox at {o.contactEmail}.</p>
            : <button type="button" disabled={link.state === 'sending'} onClick={sendLink} className={`${secondaryButton} mt-3`}>{link.state === 'sending' ? 'Sending…' : 'Set a password'}</button>}
          {link.state === 'error' && <p role="alert" className="mt-2 text-sm text-danger-700">{link.message}</p>}
        </section>
      )}

      <div className="mt-10 flex flex-wrap justify-center gap-3">
        {!guest && <Link href="/account" className={secondaryButton}>Your account</Link>}
        <Link href="/shop" className={primaryButton}>Continue shopping</Link>
      </div>
    </div>
  );
}
