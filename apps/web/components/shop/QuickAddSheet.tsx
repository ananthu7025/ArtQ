'use client';
// Quick add (product.md §6, design-system.md §5.7, §5.8): a bottom sheet on phones, a dialog on wider screens.
// Options and live stock come from the API when it opens; Size → Colour → Thickness pickers show only dimensions with a
// choice. A sold-out option stays selectable (crossed out, read as "sold out") and offers "Notify me"; an option that does
// not exist with the other choices is selectable too and switches them to the nearest real combination (in stock first).
// Neither is aria-disabled: both do something when chosen.
// If prices and stock cannot be loaded, nothing can be added (architecture.md §6.1: fail closed).
import { formatINR, notifyMeBody, type Availability, type ProductDetail, type PublicVariant } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import * as Dialog from '@radix-ui/react-dialog';
import { Minus, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { ApiError, clientRequest } from '../../lib/api';
import { applyServerErrors, FormAlert, TextField } from '../form/fields';
import { Img } from '../Img';
import { errorText, useShop } from './ShopProvider';
import { OptionPicker, startVariant, stockMap, useVariantPicker, type Stock } from './variant-picker';

type Loaded = { product: ProductDetail; stock: Stock };

const notifyForm = notifyMeBody.pick({ email: true });

export function NotifyForm({ slug, variant }: { slug: string; variant: PublicVariant }) {
  const [done, setDone] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<z.input<typeof notifyForm>, unknown, z.output<typeof notifyForm>>({ resolver: zodResolver(notifyForm), defaultValues: { email: '' } });
  const submit = handleSubmit(async ({ email }) => {
    setAlert(null);
    try {
      const r = await clientRequest<{ status: string }>('POST', `/products/${slug}/notify`, { variantId: variant.id, email });
      setDone(r.status === 'SUBSCRIBED' ? `We’ll email you when ${variant.label} is back in stock.` : `You’re already on the list for ${variant.label}.`);
    } catch (e) {
      if (applyServerErrors(e, setError, ['email'])) return;
      setAlert(e instanceof ApiError && e.code === 'IN_STOCK' ? 'Good news: this is back in stock. Close this and add it to your cart.' : errorText(e));
    }
  });
  if (done) return <p role="status" className="rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-800">{done}</p>;
  return (
    <form noValidate onSubmit={(e) => { void submit(e); }} className="space-y-3">
      <p className="text-sm text-ink-700">{variant.label} is out of stock. Leave your email and we’ll tell you when it’s back.</p>
      <TextField id="notify-email" label="Email address" type="email" autoComplete="email" inputMode="email" error={errors.email?.message} {...register('email')} />
      {alert && <FormAlert>{alert}</FormAlert>}
      <button type="submit" disabled={isSubmitting} aria-busy={isSubmitting || undefined} className="flex h-12 w-full items-center justify-center rounded-md border-[1.5px] border-ink-900 text-sm font-semibold uppercase tracking-[0.06em] text-ink-900 hover:bg-ink-900 hover:text-white disabled:border-surface-200 disabled:bg-surface-100 disabled:text-ink-500 md:h-11">
        {isSubmitting ? 'Saving…' : 'Notify me'}
      </button>
    </form>
  );
}

export function QuickAddSheet({ slug, name, open, onOpenChange, onClosed }: { slug: string; name: string; open: boolean; onOpenChange: (o: boolean) => void; onClosed?: () => void }) {
  const { addToCart } = useShop();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const picker = useVariantPicker(loaded?.product ?? null, loaded?.stock ?? null);
  const { selected, live, max } = picker;

  useEffect(() => {
    if (!open) return;
    let live = true;
    Promise.all([clientRequest<ProductDetail>('GET', `/products/${slug}`), clientRequest<Availability>('GET', `/products/${slug}/availability`)])
      .then(([product, availability]) => {
        if (!live) return;
        const stock = stockMap(availability);
        setLoaded({ product, stock });
        picker.reset(startVariant(product, stock));   // the cheapest size in stock (or the cheapest at all)
        setQty(1); setFailed(false); setProblem(null);
      })
      .catch(() => { if (live) { setLoaded(null); setFailed(true); } });
    return () => { live = false; };
  }, [open, slug]);   // eslint-disable-line react-hooks/exhaustive-deps -- reload only when opened for a product

  const add = async () => {
    if (!selected || max === 0) return;
    setBusy(true); setProblem(null);
    const r = await addToCart(selected.id, qty, `${loaded!.product.name} (${selected.label})`);
    setBusy(false);
    if (r.ok) onOpenChange(false); else setProblem(r.message);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-900/50" />
        <Dialog.Content aria-describedby={undefined} onCloseAutoFocus={(e) => { if (onClosed) { e.preventDefault(); onClosed(); } }}
          className="fixed inset-x-0 bottom-0 z-[60] max-h-[85dvh] overflow-y-auto rounded-t-xl bg-white p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-xl focus:outline-none md:inset-auto md:left-1/2 md:top-1/2 md:w-[560px] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl">
          <div className="mb-4 flex items-start justify-between gap-4">
            <Dialog.Title className="font-display text-xl font-semibold text-ink-900">{name}</Dialog.Title>
            <Dialog.Close className="-mr-2 -mt-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-surface-100" aria-label="Close"><X aria-hidden size={22} /></Dialog.Close>
          </div>
          {failed && <FormAlert>Prices and stock are temporarily unavailable. Please try again in a moment.</FormAlert>}
          {!loaded && !failed && <p role="status" className="py-8 text-center text-ink-700">Loading options…</p>}
          {loaded && (
            <div className="space-y-5">
              <div className="flex items-center gap-4">
                {(selected?.image ?? loaded.product.images[0]) && <Img media={(selected?.image ?? loaded.product.images[0])!} alt="" sizes="80px" className="h-20 w-20 shrink-0 rounded-md object-cover" />}
                {selected
                  ? (
                    <p className="flex flex-wrap items-baseline gap-x-2" aria-live="polite">
                      <span className="text-[22px] font-bold text-ink-900">{formatINR(selected.price)}</span>
                      {selected.mrp !== null && <s className="text-sm text-ink-500"><span className="sr-only">MRP </span>{formatINR(selected.mrp)}</s>}
                      {selected.discountPercent !== null && <span className="text-sm font-semibold text-brand-700">{selected.discountPercent}% OFF</span>}
                      <span className="w-full text-sm text-ink-700">{max === 0 ? 'Out of stock' : live?.stockStatus === 'LOW_STOCK' ? 'Only a few left' : 'In stock'}</span>
                    </p>
                  )
                  : <p className="text-sm text-ink-700" aria-live="polite">Choose the options below.</p>}
              </div>
              <OptionPicker picker={picker} onChoose={() => { setQty(1); setProblem(null); }} />
              {selected && max > 0 && (
                <>
                  <div className="flex items-center gap-3">
                    <span id="qty-label" className="text-[13px] font-medium text-ink-900">Quantity</span>
                    <div role="group" aria-labelledby="qty-label" className="inline-flex items-center rounded-md border border-border-input">
                      <button type="button" onClick={() => setQty((q) => Math.max(1, q - 1))} disabled={qty <= 1} aria-label="Decrease quantity" className="flex h-11 w-11 items-center justify-center disabled:text-ink-500"><Minus aria-hidden size={16} /></button>
                      <output aria-live="polite" className="w-10 text-center font-semibold tabular-nums text-ink-900">{qty}</output>
                      <button type="button" onClick={() => setQty((q) => Math.min(max, q + 1))} disabled={qty >= max} aria-label="Increase quantity" className="flex h-11 w-11 items-center justify-center disabled:text-ink-500"><Plus aria-hidden size={16} /></button>
                    </div>
                    {qty >= max && max < 50 && <span className="text-sm text-ink-700">Only {max} available</span>}
                  </div>
                  {problem && <FormAlert>{problem}</FormAlert>}
                  <button type="button" onClick={() => void add()} disabled={busy} aria-busy={busy || undefined}
                    className="flex h-12 w-full items-center justify-center rounded-md bg-brand-700 text-sm font-semibold uppercase tracking-[0.06em] text-white hover:bg-brand-800 disabled:bg-surface-100 disabled:text-ink-500 md:h-11">
                    {busy ? 'Adding…' : `Add to cart · ${formatINR(selected.price * qty)}`}
                  </button>
                </>
              )}
              {selected && max === 0 && <NotifyForm key={selected.id} slug={slug} variant={selected} />}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
