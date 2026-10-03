'use client';
// /checkout (product.md §5.6): 1 Contact (account details, or a guest's email + mobile, unverified) · 2 Delivery (a saved
// address or a new one; the pincode fills in state and city, then delivery is checked separately; billing same or
// different; optional GSTIN) · 3 Payment (shipping line, Pay online or Cash on Delivery when allowed, with the reason
// otherwise and the fee; note; terms; PLACE ORDER · total). The totals come from POST /checkout/quote for the chosen
// pincode and payment method. Placing and paying: useCheckoutFlow.
import { formatINR, type AddressView, type CheckoutQuote, type PincodePlace, type StateOption } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { Lock } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useForm, useWatch, type Path, type UseFormReturn } from 'react-hook-form';
import { ApiError, clientRequest } from '../../lib/api';
import { useAuth } from '../account/AuthProvider';
import { SHIPPING_PROBLEM } from '../cart/parts';
import { applyServerErrors, CheckboxField, FormAlert, primaryButton, SelectField, textLink, TextField } from '../form/fields';
import { Img, ImgPlaceholder } from '../Img';
import { errorText, useApi, useShop } from '../shop/ShopProvider';
import { CHECKOUT_FIELDS, checkoutForm, emptyCheckout, type CheckoutValues } from './checkout-form';
import { FlowPanel } from './FlowPanel';
import { useCheckoutFlow, type FlowDeps } from './useCheckoutFlow';

const COD_REASON: Record<NonNullable<CheckoutQuote['cod']['reason']>, string> = {
  COD_DISABLED: 'Cash on delivery is not available right now.',
  PINCODE_NO_COD: 'Cash on delivery is not available for this pincode.',
  BELOW_MIN: 'Cash on delivery needs a larger order.',
  ABOVE_MAX: 'This order is above the cash on delivery limit. Please pay online.',
  NO_DESTINATION: 'Add your delivery address to see if cash on delivery is available.',
};
const PLACE_PROBLEM: Record<string, string> = {
  CART_EMPTY: 'Your cart is empty.',
  DESTINATION_REQUIRED: 'Add your delivery address.',
  COD_NOT_AVAILABLE: 'Choose another way to pay.',
  ONLINE_DISABLED: 'Paying online is not available right now. Choose cash on delivery.',
};
const title = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export function CheckoutPage({ flowDeps }: { flowDeps?: FlowDeps }) {
  const { status, user } = useAuth();
  const { cart, cartFailed, reloadCart } = useShop();
  const router = useRouter();
  const flow = useCheckoutFlow(flowDeps);
  const [cod, setCod] = useState<{ allowed: boolean; fee: number }>({ allowed: false, fee: 0 });
  useEffect(() => { if (flow.state.step === 'placed') router.replace(`/checkout/success/${encodeURIComponent(flow.state.orderNumber)}`); }, [flow.state, router]);
  if (status === 'loading' || (!cart && !cartFailed)) return <Shell><p role="status" className="py-16 text-center text-ink-700">Loading checkout…</p></Shell>;
  if (!cart) return <Shell><FormAlert>We couldn’t load your cart. <button type="button" className="underline" onClick={reloadCart}>Try again</button></FormAlert></Shell>;
  if (flow.state.step !== 'idle' && flow.state.step !== 'placing') return <Shell><FlowPanel state={flow.state} retry={flow.retry} codAllowed={cod.allowed} codFee={cod.fee} /></Shell>;
  if (cart.items.length === 0) {
    return <Shell><div className="py-16 text-center"><p className="text-xl font-semibold text-ink-900">Your cart is empty</p><Link href="/shop" className={`${primaryButton} mt-6`}>Start shopping</Link></div></Shell>;
  }
  return <Shell><CheckoutForm key={user?.id ?? 'guest'} placing={flow.state.step === 'placing'} place={flow.place} onCod={setCod} /></Shell>;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-8 md:px-6 md:py-12">
      <h1 className="flex items-center gap-2 font-display text-[28px] font-semibold text-ink-900 md:text-[34px]">Checkout <Lock aria-hidden size={20} className="text-ink-500" /><span className="sr-only">(secure)</span></h1>
      <div className="mt-6">{children}</div>
    </div>
  );
}

function Step({ n, title: t, id, children }: { n: number; title: string; id: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-lg border border-surface-200 p-5 md:p-6">
      <h2 id={id} aria-label={`Step ${n}: ${t}`} className="mb-4 flex items-center gap-3 text-lg font-semibold text-ink-900">
        <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded-full bg-ink-900 text-sm text-white">{n}</span>
        {t}
      </h2>
      {children}
    </section>
  );
}

function CheckoutForm({ placing, place, onCod }: { placing: boolean; place: (body: unknown) => Promise<void>; onCod: (c: { allowed: boolean; fee: number }) => void }) {
  const { user } = useAuth();
  const { cart } = useShop();
  const api = useApi();
  const signedIn = user !== null;
  const [addresses, setAddresses] = useState<AddressView[] | null>(signedIn ? null : []);
  const [states, setStates] = useState<StateOption[]>([]);
  const [quote, setQuote] = useState<CheckoutQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [problem, setProblem] = useState<ReactNode>(null);
  const expected = quote?.cart.totals.total ?? 0;
  const resolver = useMemo(() => zodResolver(checkoutForm(() => expected, signedIn)), [expected, signedIn]);
  const form = useForm<CheckoutValues, unknown, unknown>({ resolver, defaultValues: emptyCheckout({ email: user?.email, phone: user?.phone ?? undefined, name: user?.name ?? undefined }) });
  const { control, setValue, handleSubmit, setError, register, formState: { errors } } = form;
  const [choice, pincode, method, billingSame] = useWatch({ control, name: ['addressChoice', 'shippingAddress.pincode', 'paymentMethod', 'billingSameAsShipping'] });

  useEffect(() => { clientRequest<{ data: StateOption[] }>('GET', '/states').then((r) => setStates(r.data)).catch(() => setStates([])); }, []);
  // Saved addresses: the default is chosen; none → a new address.
  useEffect(() => {
    if (!signedIn) return;
    api<{ data: AddressView[] }>('GET', '/me/addresses').then((r) => {
      setAddresses(r.data);
      const d = r.data.find((a) => a.isDefault) ?? r.data[0];
      if (d) setValue('addressChoice', String(d.id));
    }).catch(() => setAddresses([]));
  }, [api, signedIn, setValue]);

  // The quote for the chosen address (or the pincode being typed) and payment method.
  const quoteFor = choice !== 'new' ? { shippingAddressId: Number(choice) } : /^[1-9]\d{5}$/.test(pincode ?? '') ? { pincode } : null;
  const quoteKey = JSON.stringify([quoteFor, method, cart?.totals.subtotal, cart?.totals.itemCount, cart?.coupon?.code]);
  const [requote, setRequote] = useState(0);
  useEffect(() => {
    if (!quoteFor) return;
    let live = true;
    const t = setTimeout(() => {
      setQuoting(true);
      api<CheckoutQuote>('POST', '/checkout/quote', { ...quoteFor, paymentMethod: method })
        .then((q) => { if (live) { setQuote(q); onCod({ allowed: q.cod.available, fee: q.cod.fee }); } })
        .catch((e: unknown) => { if (live) setProblem(errorText(e)); })
        .finally(() => { if (live) setQuoting(false); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [quoteKey, requote]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = quoteFor ? quote : null;
  const c = shown?.cart ?? cart!;
  const ship = c.totals.shipping;
  const cod = shown?.cod ?? null;
  // A choice that is no longer possible switches back to paying online.
  useEffect(() => { if (method === 'COD' && cod && !cod.available && cod.reason !== 'NO_DESTINATION') setValue('paymentMethod', 'RAZORPAY'); }, [cod, method, setValue]);
  const blocking = (shown?.blocking ?? ['DESTINATION_REQUIRED']).filter((b) => !b.startsWith('UNAVAILABLE') && !b.startsWith('INSUFFICIENT_STOCK'));
  const unavailable = c.items.some((i) => !i.available);
  const shipProblem = ship.problem ? SHIPPING_PROBLEM[ship.problem] : null;

  const submit = handleSubmit(async (body) => {
    setProblem(null);
    if (!shown) { setProblem('Add your delivery address.'); return; }
    try {
      await place(body);   // the shared schema's output: normalised mobile, trimmed lines, the quoted total
    } catch (e) {
      if (applyServerErrors(e, setError, CHECKOUT_FIELDS as unknown as Path<CheckoutValues>[])) return;
      if (e instanceof ApiError) {
        if (e.code === 'PRICE_CHANGED') { setProblem('The price or shipping changed. Check the new total, then place your order again.'); setRequote((n) => n + 1); return; }
        if (e.code === 'OUT_OF_STOCK') { setProblem(<>Some items are no longer available in that quantity. <Link href="/cart" className="underline">Review your cart</Link></>); return; }
        if ((e.code === 'PINCODE_NOT_SERVICEABLE' || e.code === 'SHIPPING_RESTRICTED') && choice === 'new') { setError('shippingAddress.pincode', { type: 'server', message: e.message }, { shouldFocus: true }); return; }
        if (e.code === 'COD_NOT_AVAILABLE') { setError('paymentMethod', { type: 'server', message: e.message }); return; }
      }
      setProblem(errorText(e));
    }
  });

  return (
    <form noValidate onSubmit={(e) => { void submit(e); }} className="grid gap-8 lg:grid-cols-[1fr_380px]">
      <div className="space-y-5">
        <Step n={1} title="Contact" id="step-contact">
          {signedIn ? (
            <div className="space-y-4">
              <p className="text-sm text-ink-700">Order updates go to <strong className="text-ink-900">{user.email}</strong>.</p>
              <div className="max-w-sm"><MobileField form={form} /></div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-ink-700">Have an account? <Link href="/login?next=/checkout" className={textLink}>Log in</Link> for saved addresses.</p>
              <div className="grid gap-4 md:grid-cols-2">
                <TextField id="co-email" label="Email" type="email" autoComplete="email" inputMode="email" error={errors.contact?.email?.message} {...register('contact.email')} />
                <MobileField form={form} />
              </div>
              <CheckboxField id="co-setpw" label="Email me a link to set a password (to track this order and check out faster next time)" {...register('contact.sendSetPasswordLink')} />
            </div>
          )}
        </Step>

        <Step n={2} title="Delivery address" id="step-address">
          {addresses === null ? <p role="status" className="text-sm text-ink-700">Loading your addresses…</p> : (
            <div className="space-y-4">
              {addresses.length > 0 && (
                <fieldset>
                  <legend className="sr-only">Deliver to</legend>
                  <div className="grid gap-3 md:grid-cols-2">
                    {addresses.map((a) => (
                      <label key={a.id} className="flex cursor-pointer gap-3 rounded-md border border-border-input p-3 text-sm has-[:checked]:border-brand-700 has-[:checked]:bg-brand-50">
                        <input type="radio" value={String(a.id)} className="mt-0.5 accent-brand-700" {...register('addressChoice')} />
                        <span><span className="block font-medium text-ink-900">{a.fullName}{a.isDefault && <span className="ml-2 text-xs font-normal text-brand-700">Default</span>}</span>
                          <span className="text-ink-700">{a.line1}{a.line2 ? `, ${a.line2}` : ''}, {a.city}, {a.state.name} {a.pincode}</span></span>
                      </label>
                    ))}
                    <label className="flex cursor-pointer items-center gap-3 rounded-md border border-dashed border-border-input p-3 text-sm has-[:checked]:border-brand-700 has-[:checked]:bg-brand-50">
                      <input type="radio" value="new" className="accent-brand-700" {...register('addressChoice')} />
                      <span className="font-medium text-ink-900">Deliver to a new address</span>
                    </label>
                  </div>
                </fieldset>
              )}
              {choice === 'new' && <AddressFields form={form} prefix="shippingAddress" states={states} idp="ship" showSave={signedIn} />}
              {errors.shippingAddress?.message && <p className="text-sm text-danger-700">{errors.shippingAddress.message}</p>}
              <p role="status" className={`text-sm ${shipProblem ? 'text-danger-700' : 'text-ink-700'}`}>
                {quoting ? 'Checking delivery…' : shipProblem ?? (shown && ship.amount !== null ? `We deliver here${shown.cod.available ? ', with cash on delivery' : ''}.` : '')}
              </p>
              <CheckboxField id="co-billing-same" label="Billing address is the same as delivery" {...register('billingSameAsShipping')} />
              {!billingSame && <AddressFields form={form} prefix="billingAddress" states={states} idp="bill" showSave={false} />}
              <GstFields form={form} />
            </div>
          )}
        </Step>

        <Step n={3} title="Shipping & payment" id="step-payment">
          <div className="space-y-4">
            <p className="text-sm text-ink-900">
              <span className="font-medium">Shipping: </span>
              {shipProblem ?? (ship.amount === null ? 'Add your delivery address to see the shipping charge.' : ship.amount === 0 ? 'Free' : ship.freeApplied && ship.heavySurcharge ? `Free shipping + ${formatINR(ship.heavySurcharge)} for the extra weight` : formatINR(ship.amount))}
            </p>
            <fieldset aria-describedby={errors.paymentMethod ? 'co-pay-error' : undefined}>
              <legend className="mb-2 text-sm font-medium text-ink-900">How would you like to pay?</legend>
              <div className="space-y-2">
                <label className="flex cursor-pointer gap-3 rounded-md border border-border-input p-3 text-sm has-[:checked]:border-brand-700 has-[:checked]:bg-brand-50 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70">
                  <input type="radio" value="RAZORPAY" disabled={shown?.onlineEnabled === false} className="mt-0.5 accent-brand-700" {...register('paymentMethod')} />
                  <span><span className="block font-medium text-ink-900">Pay online</span><span className="text-ink-700">UPI, cards, net banking and wallets (Razorpay)</span></span>
                </label>
                <label className="flex cursor-pointer gap-3 rounded-md border border-border-input p-3 text-sm has-[:checked]:border-brand-700 has-[:checked]:bg-brand-50 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70">
                  <input type="radio" value="COD" disabled={!cod?.available} aria-describedby="co-cod-note" className="mt-0.5 accent-brand-700" {...register('paymentMethod')} />
                  <span><span className="block font-medium text-ink-900">Cash on delivery{cod && cod.fee > 0 ? ` (+ ${formatINR(cod.fee)})` : ''}</span>
                    <span id="co-cod-note" className="text-ink-700">{cod?.available ? 'Pay when it arrives.' : COD_REASON[cod?.reason ?? 'NO_DESTINATION']}</span></span>
                </label>
              </div>
              {errors.paymentMethod && <p id="co-pay-error" className="mt-1 text-sm text-danger-700">{errors.paymentMethod.message}</p>}
            </fieldset>
            <div>
              <label htmlFor="co-note" className="block text-[13px] font-medium text-ink-900">Note for us (optional)</label>
              <textarea id="co-note" rows={2} maxLength={500} {...register('customerNote')} aria-invalid={errors.customerNote ? true : undefined} aria-describedby={errors.customerNote ? 'co-note-error' : undefined}
                className="mt-1 block w-full rounded-md border border-border-input bg-white px-3 py-2 text-base text-ink-900" />
              {errors.customerNote && <p id="co-note-error" className="mt-1 text-sm text-danger-700">{errors.customerNote.message}</p>}
            </div>
            <CheckboxField id="co-terms" label={<>I agree to the <Link href="/terms" className={textLink}>terms</Link>, including the <Link href="/returns" className={textLink}>returns policy</Link></>} error={errors.acceptTerms?.message} {...register('acceptTerms')} />
          </div>
        </Step>
      </div>

      <aside aria-labelledby="co-summary" className="space-y-4 lg:sticky lg:top-24 lg:self-start">
        <section aria-labelledby="co-summary" className="rounded-lg bg-surface-50 p-4 text-sm">
          <h2 id="co-summary" className="mb-3 text-base font-semibold text-ink-900">Your order</h2>
          <ul className="space-y-3">
            {c.items.filter((i) => i.available).map((i) => (
              <li key={i.id} className="flex gap-3">
                <div className="h-14 w-14 shrink-0 overflow-hidden rounded bg-surface-100">{i.image ? <Img media={i.image} sizes="56px" className="h-full w-full object-cover" alt="" /> : <ImgPlaceholder className="h-full w-full" />}</div>
                <div className="min-w-0 flex-1"><p className="truncate text-ink-900">{i.productName}</p><p className="text-ink-700">{i.variantLabel} · Qty {i.quantity}</p></div>
                <p className="text-ink-900">{formatINR(i.lineTotal)}</p>
              </li>
            ))}
          </ul>
          <dl className="mt-4 space-y-2 border-t border-surface-200 pt-3">
            <div className="flex justify-between"><dt className="text-ink-700">Subtotal</dt><dd className="text-ink-900">{formatINR(c.totals.subtotal)}</dd></div>
            {c.totals.couponDiscount > 0 && <div className="flex justify-between"><dt className="text-ink-700">Coupon {c.coupon?.code}</dt><dd className="text-success-700">−{formatINR(c.totals.couponDiscount)}</dd></div>}
            <div className="flex justify-between"><dt className="text-ink-700">Shipping</dt><dd className="text-ink-900">{ship.amount === null ? '—' : ship.amount === 0 ? 'Free' : formatINR(ship.amount)}</dd></div>
            {c.totals.codFee > 0 && <div className="flex justify-between"><dt className="text-ink-700">Cash on delivery fee</dt><dd className="text-ink-900">{formatINR(c.totals.codFee)}</dd></div>}
            <div className="flex justify-between border-t border-surface-200 pt-2 text-base"><dt className="font-semibold text-ink-900">Total</dt><dd className="font-semibold text-ink-900">{formatINR(c.totals.total)}</dd></div>
          </dl>
          <p className="mt-2 text-xs text-ink-500">Prices include all taxes.</p>
        </section>
        {unavailable && <FormAlert>Some items in your cart are no longer available. <Link href="/cart" className="underline">Review your cart</Link></FormAlert>}
        {!unavailable && shown && blocking.length > 0 && !blocking.every((b) => PLACE_PROBLEM[b] === undefined) && <p className="text-sm text-danger-700">{blocking.map((b) => PLACE_PROBLEM[b]).filter(Boolean).join(' ')}</p>}
        {problem && <FormAlert>{problem}</FormAlert>}
        <button type="submit" disabled={placing || unavailable} className={`${primaryButton} w-full`}>{placing ? 'Placing your order…' : `Place order · ${formatINR(c.totals.total)}`}</button>
        <p className="text-center text-xs text-ink-500">Your items are held for 30 minutes while you pay.</p>
      </aside>
    </form>
  );
}

function MobileField({ form }: { form: UseFormReturn<CheckoutValues, unknown, unknown> }) {
  return <TextField id="co-phone" label="Mobile number" type="tel" autoComplete="tel" inputMode="tel" placeholder="98470 12345" error={form.formState.errors.contact?.phone?.message} {...form.register('contact.phone')} />;
}

function AddressFields({ form, prefix, states, idp, showSave }: { form: UseFormReturn<CheckoutValues, unknown, unknown>; prefix: 'shippingAddress' | 'billingAddress'; states: StateOption[]; idp: string; showSave: boolean }) {
  const { register, setValue, getValues, control, formState: { errors } } = form;
  const e = errors[prefix] as Record<string, { message?: string } | undefined> | undefined;
  const pin = useWatch({ control, name: `${prefix}.pincode` });
  const [place, setPlace] = useState<string | null>(null);
  const looked = useRef('');
  // A complete pincode fills in the state, and the city when still empty (delivery is checked separately).
  useEffect(() => {
    if (!/^[1-9]\d{5}$/.test(pin ?? '') || pin === looked.current) return;
    looked.current = pin!;
    let live = true;
    clientRequest<PincodePlace>('GET', `/pincodes/${pin}`).then((p) => {
      if (!live) return;
      setValue(`${prefix}.stateId`, p.state.id, { shouldDirty: true });
      if (!getValues(`${prefix}.city`)?.trim()) setValue(`${prefix}.city`, title(p.district), { shouldDirty: true });
      setPlace(`${title(p.district)}, ${p.state.name}`);
    }).catch(() => { if (live) setPlace(null); });
    return () => { live = false; };
  }, [pin, prefix, setValue, getValues]);
  const strip = { setValueAs: (v: string) => v.replace(/[\s-]/g, '') };
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <TextField id={`${idp}-name`} label="Full name" autoComplete={`${idp === 'ship' ? 'shipping' : 'billing'} name`} error={e?.fullName?.message} {...register(`${prefix}.fullName`)} />
      <TextField id={`${idp}-phone`} label="Phone for delivery" type="tel" autoComplete="tel" inputMode="tel" error={e?.phone?.message} {...register(`${prefix}.phone`, strip)} />
      <div>
        <TextField id={`${idp}-pincode`} label="Pincode" inputMode="numeric" autoComplete={`${idp === 'ship' ? 'shipping' : 'billing'} postal-code`} maxLength={6} error={e?.pincode?.message} {...register(`${prefix}.pincode`)} />
        {place && !e?.pincode && <p className="mt-1 text-sm text-ink-500">{place}</p>}
      </div>
      <SelectField id={`${idp}-state`} label="State" error={e?.stateId?.message} {...register(`${prefix}.stateId`, { setValueAs: (v: string | number) => (v === '' || v === undefined ? undefined : Number(v)) })}>
        <option value="">Choose a state</option>
        {states.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </SelectField>
      <div className="md:col-span-2"><TextField id={`${idp}-line1`} label="House / flat, building and street" autoComplete={`${idp === 'ship' ? 'shipping' : 'billing'} address-line1`} error={e?.line1?.message} {...register(`${prefix}.line1`)} /></div>
      <TextField id={`${idp}-line2`} label="Area / locality (optional)" autoComplete={`${idp === 'ship' ? 'shipping' : 'billing'} address-line2`} error={e?.line2?.message} {...register(`${prefix}.line2`)} />
      <TextField id={`${idp}-landmark`} label="Landmark (optional)" error={e?.landmark?.message} {...register(`${prefix}.landmark`)} />
      <TextField id={`${idp}-city`} label="City / town" autoComplete={`${idp === 'ship' ? 'shipping' : 'billing'} address-level2`} error={e?.city?.message} {...register(`${prefix}.city`)} />
      {showSave && <div className="flex items-end pb-3"><CheckboxField id={`${idp}-save`} label="Save to my addresses" {...register('shippingAddress.save')} /></div>}
    </div>
  );
}

function GstFields({ form }: { form: UseFormReturn<CheckoutValues, unknown, unknown> }) {
  const { register, control, formState: { errors } } = form;
  const on = useWatch({ control, name: 'gstOn' });
  return (
    <div className="space-y-3">
      <CheckboxField id="co-gst" label="Add a GSTIN for a business invoice (optional)" {...register('gstOn')} />
      {on && (
        <div className="grid gap-4 md:grid-cols-2">
          <TextField id="co-gstin" label="GSTIN" autoCapitalize="characters" spellCheck={false} maxLength={15} error={errors.gstin?.message} {...register('gstin')} />
          <TextField id="co-business" label="Business name" autoComplete="organization" error={errors.businessName?.message} {...register('businessName')} />
        </div>
      )}
    </div>
  );
}
