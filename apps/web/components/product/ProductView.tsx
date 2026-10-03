'use client';
// Product page top (product.md §5.3): gallery + buy box. Live prices and stock are loaded in the browser (never from the
// cached page); until they arrive the page shows the cached prices and waits, and if they cannot be loaded nothing can
// be added (architecture.md §6.1). The chosen variant is kept in the address as ?variant=<sku>. Below 1024 px a bar
// with the price and "Add to cart" sticks to the bottom once the main button has scrolled away.
import { formatINR, type ProductDetail, type PublicVariant } from '@artq/shared';
import { Heart, Minus, Plus, RotateCcw, ShieldCheck, Truck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { clientRequest } from '../../lib/api';
import { FormAlert } from '../form/fields';
import { NotifyForm } from '../shop/QuickAddSheet';
import { useShop } from '../shop/ShopProvider';
import { OptionPicker, startVariant, stockMap, useVariantPicker, type Stock } from '../shop/variant-picker';
import { Gallery } from './Gallery';
import { PincodeCheck } from './PincodeCheck';

export function ProductView({ product, initialSku, returnWindowHours }: { product: ProductDetail; initialSku: string | null; returnWindowHours: number }) {
  const router = useRouter();
  const { addToCart, wishlist, toggleWishlist, setWhatsappTopic } = useShop();
  const [stock, setStock] = useState<Stock | null>(null);
  const [failed, setFailed] = useState(false);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState<'add' | 'buy' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sticky, setSticky] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const picker = useVariantPicker(product, stock, startVariant(product, null, initialSku));
  const { selected, live } = picker;

  useEffect(() => {
    let alive = true;
    clientRequest<{ variants: [] }>('GET', `/products/${product.slug}/availability`)
      .then((a) => {
        if (!alive) return;
        const s = stockMap(a as never);
        setStock(s);
        // No variant asked for: start on the cheapest one in stock.
        if (!initialSku) picker.reset(startVariant(product, s));
      })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [product.slug]);   // eslint-disable-line react-hooks/exhaustive-deps -- once per product

  useEffect(() => { setWhatsappTopic(product.name); return () => setWhatsappTopic(null); }, [product.name, setWhatsappTopic]);

  // The bar shows once the main button is above the screen. A scroll listener, not an IntersectionObserver: a jump or
  // a fast fling can move the button from below the screen to above it without it ever being "visible" in between.
  useEffect(() => {
    let frame = 0;
    const update = () => { frame = 0; const el = addButton.current; setSticky(Boolean(el && el.getBoundingClientRect().bottom < 0)); };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    window.addEventListener('scroll', onScroll, { passive: true });
    update();
    return () => { window.removeEventListener('scroll', onScroll); if (frame) cancelAnimationFrame(frame); };
  }, [stock]);

  const onChoose = (v: PublicVariant | undefined) => {
    setQty(1); setProblem(null);
    const url = new URL(window.location.href);
    if (v && product.variants.length > 1) url.searchParams.set('variant', v.sku); else url.searchParams.delete('variant');
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  };

  const ready = stock !== null && !failed;
  const max = ready ? picker.max : 0;
  const soldOut = ready && selected !== undefined && max === 0;
  const saved = wishlist.includes(product.id);
  const price = selected?.price ?? product.fromPrice;
  const mrp = selected ? selected.mrp : null;

  const add = async (then?: 'buy') => {
    if (!selected || max === 0) return;
    setBusy(then === 'buy' ? 'buy' : 'add'); setProblem(null);
    const r = await addToCart(selected.id, qty, product.variants.length > 1 ? `${product.name} (${selected.label})` : product.name);
    setBusy(null);
    if (!r.ok) { setProblem(r.message); return; }
    if (then === 'buy') router.push('/checkout');
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[55fr_45fr] lg:gap-12">
      <Gallery name={product.name} images={product.images} video={product.video} focus={selected?.image ?? null} />
      <div className="lg:sticky lg:top-24 lg:self-start">
        <h1 className="font-display text-[26px] font-semibold leading-tight text-ink-900 md:text-4xl">{product.name}</h1>
        {product.shortDescription && <p className="mt-2 text-ink-700">{product.shortDescription}</p>}
        <div className="mt-4" aria-live="polite">
          <p className="flex flex-wrap items-baseline gap-x-3">
            <span className="text-[24px] font-bold text-ink-900 md:text-[28px]">{!selected && product.maxPrice > product.fromPrice ? `From ${formatINR(price)}` : formatINR(price)}</span>
            {mrp !== null && <s className="text-base text-ink-500"><span className="sr-only">MRP </span>{formatINR(mrp)}</s>}
            {selected?.discountPercent != null && <span className="font-semibold text-brand-700">{selected.discountPercent}% OFF</span>}
          </p>
          <p className="text-sm text-ink-700">Inclusive of all taxes</p>
          <p className={`mt-2 text-sm font-medium ${!ready ? 'text-ink-700' : max === 0 ? 'text-danger-700' : live?.stockStatus === 'LOW_STOCK' ? 'text-warning-700' : 'text-success-700'}`}>
            {failed ? '' : !ready ? 'Checking stock…' : !selected ? 'Choose the options below' : max === 0 ? 'Out of stock' : live?.stockStatus === 'LOW_STOCK' ? 'Only a few left' : 'In stock'}
          </p>
        </div>
        {failed && <div className="mt-3"><FormAlert>Prices and stock are temporarily unavailable. Please try again in a moment.</FormAlert></div>}
        <div className="mt-5 space-y-5"><OptionPicker picker={picker} onChoose={onChoose} /></div>
        {!soldOut && (
          <div className="mt-5 flex items-center gap-3">
            <span id="pdp-qty" className="text-[13px] font-medium text-ink-900">Quantity</span>
            <div role="group" aria-labelledby="pdp-qty" className="inline-flex items-center rounded-md border border-border-input">
              <button type="button" onClick={() => setQty((q) => Math.max(1, q - 1))} disabled={qty <= 1 || !ready} aria-label="Decrease quantity" className="flex h-11 w-11 items-center justify-center disabled:text-ink-500"><Minus aria-hidden size={16} /></button>
              <output aria-live="polite" className="w-10 text-center font-semibold tabular-nums text-ink-900">{qty}</output>
              <button type="button" onClick={() => setQty((q) => Math.min(max, q + 1))} disabled={qty >= max || !ready} aria-label="Increase quantity" className="flex h-11 w-11 items-center justify-center disabled:text-ink-500"><Plus aria-hidden size={16} /></button>
            </div>
            {ready && max > 0 && qty >= max && max < 50 && <span className="text-sm text-ink-700">Only {max} available</span>}
          </div>
        )}
        {problem && <div className="mt-3"><FormAlert>{problem}</FormAlert></div>}
        {soldOut && selected
          ? <div className="mt-5"><NotifyForm key={selected.id} slug={product.slug} variant={selected} /></div>
          : (
            <div className="mt-5 grid grid-cols-[1fr_1fr_auto] gap-2">
              <button ref={addButton} type="button" onClick={() => void add()} disabled={!ready || !selected || busy !== null} aria-busy={busy === 'add' || undefined}
                className="h-12 rounded-md bg-brand-700 text-sm font-semibold uppercase tracking-[0.06em] text-white hover:bg-brand-800 disabled:bg-surface-100 disabled:text-ink-500">{busy === 'add' ? 'Adding…' : 'Add to cart'}</button>
              <button type="button" onClick={() => void add('buy')} disabled={!ready || !selected || busy !== null} aria-busy={busy === 'buy' || undefined}
                className="h-12 rounded-md border-[1.5px] border-ink-900 text-sm font-semibold uppercase tracking-[0.06em] text-ink-900 hover:bg-ink-900 hover:text-white disabled:border-surface-200 disabled:bg-surface-100 disabled:text-ink-500">{busy === 'buy' ? 'Adding…' : 'Buy now'}</button>
              <button type="button" onClick={() => toggleWishlist(product.id)} aria-pressed={saved} aria-label={saved ? `Remove ${product.name} from wishlist` : `Save ${product.name} to wishlist`}
                className="flex h-12 w-12 items-center justify-center rounded-md border border-border-input text-ink-900 hover:bg-surface-100"><Heart aria-hidden size={20} className={saved ? 'fill-danger-700 text-danger-700' : ''} /></button>
            </div>
          )}
        <div className="mt-6"><PincodeCheck /></div>
        <ul className="mt-6 grid grid-cols-3 gap-2 text-center text-xs text-ink-700">
          <li className="flex flex-col items-center gap-1"><ShieldCheck aria-hidden size={22} className="text-brand-700" />Secure payments</li>
          <li className="flex flex-col items-center gap-1"><RotateCcw aria-hidden size={22} className="text-brand-700" />Returns within {returnWindowHours} hours of delivery</li>
          <li className="flex flex-col items-center gap-1"><Truck aria-hidden size={22} className="text-brand-700" />Ships across India</li>
        </ul>
      </div>
      {sticky && ready && selected && max > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-3 border-t border-surface-200 bg-white px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[0_-4px_12px_rgba(17,24,39,0.08)] lg:hidden">
          <div className="min-w-0 flex-1"><p className="truncate text-sm text-ink-700">{selected.label}</p><p className="font-bold text-ink-900">{formatINR(selected.price * qty)}</p></div>
          <button type="button" onClick={() => void add()} disabled={busy !== null} className="h-12 rounded-md bg-brand-700 px-6 text-sm font-semibold uppercase tracking-[0.06em] text-white hover:bg-brand-800">{busy === 'add' ? 'Adding…' : 'Add to cart'}</button>
        </div>
      )}
    </div>
  );
}
