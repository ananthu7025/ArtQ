'use client';
// /cart (product.md §5.5): lines (image, name, option, price, quantity, total; remove with Undo; move to wishlist), stock
// and price-change notes, free-shipping progress, the coupon box (checked now; the use is only taken when the order is
// placed) with the public coupons, a shipping estimate for a pincode, the summary and the empty state.
import { cartCouponBody, couponSummary, formatINR, pincodeForm, type CartView, type PublicCoupon } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { Heart, Minus, Plus, Tag, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { ApiError } from '../../lib/api';
import { applyServerErrors, FormAlert, primaryButton, secondaryButton, textLink, TextField } from '../form/fields';
import { Img, ImgPlaceholder } from '../Img';
import { errorText, useApi, useShop } from '../shop/ShopProvider';
import { FreeShippingProgress, itemsText, SHIPPING_PROBLEM } from './parts';

type Item = CartView['items'][number];

export function CartPage() {
  const { cart, cartFailed, reloadCart } = useShop();
  if (!cart) {
    return (
      <Shell>
        {cartFailed
          ? <FormAlert>We couldn’t load your cart. <button type="button" className="underline" onClick={reloadCart}>Try again</button></FormAlert>
          : <p role="status" className="py-16 text-center text-ink-700">Loading your cart…</p>}
      </Shell>
    );
  }
  if (cart.items.length === 0) {
    return (
      <Shell>
        <div className="py-16 text-center">
          <p className="text-xl font-semibold text-ink-900">Your cart is empty</p>
          <p className="mt-2 text-ink-700">Find resins, moulds, pigments and more.</p>
          <Link href="/shop" className={`${primaryButton} mt-6`}>Start shopping</Link>
        </div>
      </Shell>
    );
  }
  const blocked = cart.items.some((i) => !i.available);
  return (
    <Shell count={cart.totals.itemCount}>
      {cart.warnings.length > 0 && (
        <div role="status" className="mb-5 rounded-md border border-warning-ink/30 bg-warning-bg px-4 py-3 text-sm text-warning-ink">
          <p className="font-semibold">Some items changed since you added them</p>
          <ul className="mt-1 list-disc pl-5">{cart.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      )}
      <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
        <ul aria-label="Items in your cart" className="divide-y divide-surface-200 border-y border-surface-200">
          {cart.items.map((i) => <Line key={i.id} item={i} />)}
        </ul>
        <aside aria-labelledby="summary-heading" className="space-y-5 lg:sticky lg:top-24 lg:self-start">
          <FreeShippingProgress totals={cart.totals} />
          <CouponBox cart={cart} />
          <ShippingEstimate cart={cart} />
          <Summary cart={cart} />
          {blocked
            ? <p role="alert" className="text-sm text-danger-700">Remove the items that are no longer available to continue.</p>
            : null}
          {blocked
            ? <button type="button" disabled className={`${primaryButton} w-full`}>Checkout</button>
            : <Link href="/checkout" className={`${primaryButton} w-full`}>Checkout</Link>}
          <p className="text-center text-xs text-ink-500">Prices include all taxes. Your coupon is only used when you place the order.</p>
        </aside>
      </div>
    </Shell>
  );
}

function Shell({ count, children }: { count?: number; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-8 md:px-6 md:py-12">
      <h1 className="font-display text-[28px] font-semibold text-ink-900 md:text-[34px]">Your cart{count ? <> <span className="font-sans text-base font-normal text-ink-700">({itemsText(count)})</span></> : null}</h1>
      <div className="mt-6">{children}</div>
    </div>
  );
}

function Line({ item }: { item: Item }) {
  const { cartCall, wishlist, toggleWishlist } = useShop();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const name = `${item.productName} (${item.variantLabel})`;
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true); setProblem(null);
    try { await f(); } catch (e) { setProblem(e instanceof ApiError && e.code === 'OUT_OF_STOCK' ? e.message : errorText(e)); }
    setBusy(false);
  };
  const setQty = (q: number) => run(() => cartCall('PATCH', `/cart/items/${item.id}`, { quantity: q }));
  const undo = (quantity: number) => () => { void cartCall('POST', '/cart/items', { variantId: item.variantId, quantity }).catch((e: unknown) => toast.error(errorText(e))); };
  const remove = () => run(async () => {
    await cartCall('DELETE', `/cart/items/${item.id}`);
    if (item.available) toast(`Removed ${name}`, { action: { label: 'Undo', onClick: undo(item.quantity) } });
    else toast(`Removed ${name}`);
  });
  const saved = wishlist.includes(item.productId);
  const moveToWishlist = () => run(async () => {
    await cartCall('DELETE', `/cart/items/${item.id}`);
    if (!saved) toggleWishlist(item.productId);
    toast(`Moved ${item.productName} to your wishlist`, { action: { label: 'Undo', onClick: undo(item.quantity) } });
  });
  const stepper = 'flex h-11 w-11 items-center justify-center text-ink-900 hover:bg-surface-100 disabled:text-ink-500 disabled:hover:bg-transparent';
  return (
    <li className="flex gap-4 py-5" aria-busy={busy || undefined}>
      <Link href={`/product/${item.productSlug}`} className="h-24 w-24 shrink-0 overflow-hidden rounded-md bg-surface-100 md:h-28 md:w-28" tabIndex={-1} aria-hidden>
        {item.image ? <Img media={item.image} sizes="112px" className="h-full w-full object-cover" alt="" /> : <ImgPlaceholder className="h-full w-full" />}
      </Link>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            <Link href={`/product/${item.productSlug}`} className="font-medium text-ink-900 hover:text-brand-700">{item.productName}</Link>
            <p className="text-sm text-ink-700">{item.variantLabel}</p>
            <p className="mt-1 text-sm text-ink-900">{formatINR(item.unitPrice)}{item.unitMrp && <s className="ml-2 text-ink-500"><span className="sr-only">MRP </span>{formatINR(item.unitMrp)}</s>}</p>
          </div>
          {item.available && <p className="font-semibold text-ink-900">{formatINR(item.lineTotal)}</p>}
        </div>
        {item.warning && <p className={`mt-2 text-sm ${item.available ? 'text-warning-ink' : 'text-danger-700'}`}>{item.warning}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          {item.available && (
            <div role="group" aria-label={`Quantity of ${name}`} className="flex items-center rounded-md border border-border-input">
              <button type="button" className={stepper} disabled={busy || item.quantity <= 1} onClick={() => void setQty(item.quantity - 1)} aria-label={`One less ${name}`}><Minus aria-hidden size={16} /></button>
              <span aria-live="polite" className="w-10 text-center text-sm font-medium text-ink-900">{item.quantity}</span>
              <button type="button" className={stepper} disabled={busy || item.quantity >= item.maxQuantity} onClick={() => void setQty(item.quantity + 1)} aria-label={`One more ${name}`}><Plus aria-hidden size={16} /></button>
            </div>
          )}
          <button type="button" disabled={busy} onClick={() => void remove()} className="inline-flex h-11 items-center gap-1.5 text-sm font-medium text-ink-700 hover:text-danger-700" aria-label={`Remove ${name}`}><Trash2 aria-hidden size={16} />Remove</button>
          {item.available && !saved && <button type="button" disabled={busy} onClick={() => void moveToWishlist()} className="inline-flex h-11 items-center gap-1.5 text-sm font-medium text-ink-700 hover:text-brand-700" aria-label={`Move ${name} to your wishlist`}><Heart aria-hidden size={16} />Move to wishlist</button>}
        </div>
        {item.available && item.quantity >= item.maxQuantity && <p className="mt-1 text-xs text-ink-500">{item.maxQuantity === 50 ? 'You can buy at most 50 of one item.' : `Only ${item.maxQuantity} available.`}</p>}
        {problem && <p role="alert" className="mt-2 text-sm text-danger-700">{problem}</p>}
      </div>
    </li>
  );
}

const couponForm = cartCouponBody;
const COUPON_CODES = new Set(['COUPON_INVALID', 'COUPON_EXPIRED', 'COUPON_USAGE_EXCEEDED', 'COUPON_NOT_ELIGIBLE', 'COUPON_MIN_ORDER']);

function CouponBox({ cart }: { cart: CartView }) {
  const { cartCall } = useShop();
  const api = useApi();
  const [problem, setProblem] = useState<string | null>(null);
  const [offers, setOffers] = useState<PublicCoupon[] | null>(null);
  const { register, handleSubmit, setError, reset, formState: { errors, isSubmitting } } = useForm<z.input<typeof couponForm>, unknown, z.output<typeof couponForm>>({ resolver: zodResolver(couponForm), defaultValues: { code: '' } });
  const apply = async (code: string) => {
    setProblem(null);
    try { const c = await cartCall('POST', '/cart/coupon', { code }); reset({ code: '' }); toast(`${c.coupon?.code ?? code} applied`); }
    catch (e) {
      // A refused code belongs to the code field (validation rule: a server error lands on its field).
      if (e instanceof ApiError && COUPON_CODES.has(e.code)) setError('code', { type: 'server', message: e.message }, { shouldFocus: true });
      else if (!applyServerErrors(e, setError, ['code'])) setProblem(errorText(e));
    }
  };
  const submit = handleSubmit(({ code }) => apply(code));
  const remove = async () => { try { await cartCall('DELETE', '/cart/coupon'); } catch (e) { setProblem(errorText(e)); } };
  // Public coupons, re-checked whenever the cart's value or coupon changes.
  const key = `${cart.totals.subtotal}|${cart.coupon?.code ?? ''}|${cart.totals.itemCount}`;
  useEffect(() => {
    let live = true;
    api<{ data: PublicCoupon[] }>('GET', '/cart/coupons').then((r) => { if (live) setOffers(r.data); }).catch(() => { if (live) setOffers([]); });
    return () => { live = false; };
  }, [api, key]);
  const c = cart.coupon;
  return (
    <section aria-labelledby="coupon-heading" className="rounded-lg border border-surface-200 p-4">
      <h2 id="coupon-heading" className="flex items-center gap-2 text-sm font-semibold text-ink-900"><Tag aria-hidden size={16} />Coupon</h2>
      {c ? (
        <div className="mt-3 flex items-start justify-between gap-3 rounded-md bg-surface-50 px-3 py-2.5">
          <div className="min-w-0 text-sm">
            <p className="font-mono font-semibold text-ink-900">{c.code}</p>
            <p className="text-ink-700">{c.summary}</p>
            {c.applied
              ? <p className="mt-1 font-medium text-success-700">{c.freeShipping ? 'Free shipping applied' : `You save ${formatINR(c.discount)}`}</p>
              : <p className="mt-1 text-warning-ink">{c.problem?.message}</p>}
          </div>
          <button type="button" onClick={() => void remove()} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-700 hover:bg-surface-100" aria-label={`Remove coupon ${c.code}`}><X aria-hidden size={18} /></button>
        </div>
      ) : (
        <form noValidate onSubmit={(e) => { void submit(e); }} className="mt-3 flex items-start gap-2">
          <TextField id="coupon-code" label="Coupon code" hideLabel placeholder="Coupon code" autoComplete="off" autoCapitalize="characters" spellCheck={false}
            className="flex-1" inputClassName="mt-0 block h-12 w-full rounded-md border border-border-input bg-white px-3 text-base uppercase text-ink-900 md:h-11" error={errors.code?.message} {...register('code')} />
          <button type="submit" disabled={isSubmitting} className={`${secondaryButton} shrink-0`}>{isSubmitting ? 'Checking…' : 'Apply'}</button>
        </form>
      )}
      {problem && <div className="mt-2"><FormAlert>{problem}</FormAlert></div>}
      {offers && offers.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer py-2 font-medium text-brand-700">Available coupons ({offers.length})</summary>
          <ul className="mt-2 space-y-2">
            {offers.map((o) => (
              <li key={o.code} className="flex items-start justify-between gap-3 rounded-md border border-dashed border-border-input px-3 py-2">
                <div className="min-w-0">
                  <p className="font-mono font-semibold text-ink-900">{o.code}</p>
                  <p className="text-ink-700">{o.title} · {couponSummary(o)}</p>
                  {o.reason && <p className="text-ink-500">{o.reason}</p>}
                </div>
                {c?.code === o.code
                  ? <span className="shrink-0 text-xs font-semibold uppercase text-success-700">Applied</span>
                  : <button type="button" disabled={!o.eligible || isSubmitting} onClick={() => void apply(o.code)} className={`${textLink} shrink-0 disabled:text-ink-500 disabled:no-underline`} aria-label={`Apply ${o.code}`}>Apply</button>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function ShippingEstimate({ cart }: { cart: CartView }) {
  const { pincode, setPincode } = useShop();
  const [editing, setEditing] = useState(false);
  const { register, handleSubmit, formState: { errors } } = useForm<z.input<typeof pincodeForm>, unknown, z.output<typeof pincodeForm>>({ resolver: zodResolver(pincodeForm), defaultValues: { pincode: pincode ?? '' } });
  const s = cart.totals.shipping;
  if (pincode && !editing) {
    return (
      <section aria-labelledby="ship-heading" className="rounded-lg border border-surface-200 p-4 text-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 id="ship-heading" className="font-semibold text-ink-900">Delivery to {pincode}</h2>
          <button type="button" className={textLink} onClick={() => setEditing(true)} aria-label={`Change pincode ${pincode}`}>Change</button>
        </div>
        <p role="status" className={`mt-1 ${s.problem ? 'text-danger-700' : 'text-ink-700'}`}>
          {s.problem ? SHIPPING_PROBLEM[s.problem] : s.amount === null ? 'Calculating…' : s.amount === 0 ? 'Free shipping' : `Shipping ${formatINR(s.amount)}${s.heavySurcharge ? ' (heavy order)' : ''}`}
        </p>
      </section>
    );
  }
  return (
    <section aria-labelledby="ship-heading" className="rounded-lg border border-surface-200 p-4">
      <h2 id="ship-heading" className="text-sm font-semibold text-ink-900">Estimate shipping</h2>
      <form noValidate onSubmit={(e) => { void handleSubmit(({ pincode: p }) => { setPincode(p); setEditing(false); })(e); }} className="mt-3 flex items-start gap-2">
        <TextField id="cart-pincode" label="Pincode" hideLabel placeholder="Pincode" inputMode="numeric" autoComplete="postal-code" maxLength={6} className="flex-1"
          inputClassName="mt-0 block h-12 w-full rounded-md border border-border-input bg-white px-3 text-base text-ink-900 md:h-11" error={errors.pincode?.message} {...register('pincode')} />
        <button type="submit" className={`${secondaryButton} shrink-0`}>Check</button>
      </form>
    </section>
  );
}

function Summary({ cart }: { cart: CartView }) {
  const t = cart.totals;
  const row = 'flex justify-between gap-3';
  return (
    <section aria-labelledby="summary-heading" className="rounded-lg bg-surface-50 p-4 text-sm">
      <h2 id="summary-heading" className="mb-3 text-base font-semibold text-ink-900">Order summary</h2>
      <dl className="space-y-2">
        {t.mrpDiscount > 0 && <div className={row}><dt className="text-ink-700">MRP total</dt><dd className="text-ink-700"><s>{formatINR(t.mrpTotal)}</s></dd></div>}
        <div className={row}><dt className="text-ink-700">Subtotal ({itemsText(t.itemCount)})</dt><dd className="text-ink-900">{formatINR(t.subtotal)}</dd></div>
        {t.couponDiscount > 0 && <div className={row}><dt className="text-ink-700">Coupon {cart.coupon?.code}</dt><dd className="text-success-700">−{formatINR(t.couponDiscount)}</dd></div>}
        <div className={row}><dt className="text-ink-700">Shipping</dt><dd className="text-ink-900">{t.shipping.amount === null ? (t.shipping.freeApplied ? 'Free' : 'Calculated at checkout') : t.shipping.amount === 0 ? 'Free' : formatINR(t.shipping.amount)}</dd></div>
        <div className={`${row} border-t border-surface-200 pt-3 text-base`}><dt className="font-semibold text-ink-900">Total</dt><dd className="font-semibold text-ink-900">{formatINR(t.total)}</dd></div>
      </dl>
      {t.savings > 0 && <p className="mt-2 font-medium text-success-700">You save {formatINR(t.savings)} on this order</p>}
    </section>
  );
}
