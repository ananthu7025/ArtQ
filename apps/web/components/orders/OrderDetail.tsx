'use client';
// One order as its customer sees it (task 5.7; product.md §5.10): status, items, price breakup, address, shipment,
// refunds, returns and the timeline, plus what they may do: Cancel (while not yet packed), Report a problem (within the
// return window after delivery, with photos), Download invoice (after dispatch). Used by the account order page (the
// signed-in owner, `/me/orders/:n`) and the guest order page (email verified, `/orders/:n`); the tracking link shows the
// same view read-only. Every form checks the shared schema and puts the server's refusals on the right field.
import { customerCancelOrderBody, customerReturnBody, formatINR, RETURN_REASON_LABEL, RETURN_REASONS, type CustomerOrderView, type CustomerReturnInput } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { ApiError } from '../../lib/api';
import { applyServerErrors, dangerButton, FormAlert, primaryButton, secondaryButton, SelectField, textLink, TextField } from '../form/fields';

export type Call = <T>(method: 'GET' | 'POST', path: string, body?: unknown, headers?: Record<string, string>) => Promise<T>;

const dateTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
const when = (iso: string) => dateTime.format(new Date(iso));
const RETURN_STATUS: Record<string, string> = {
  REQUESTED: 'We’re looking at it', APPROVED: 'Approved', REJECTED: 'Not accepted', IN_TRANSIT: 'On its way back to us', RECEIVED: 'Received by us',
  INSPECTED: 'Checked; refund next', REFUNDED: 'Refunded', CLOSED: 'Closed', CANCELLED: 'Cancelled',
};
const message = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');

function Section({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return <section aria-labelledby={id} className="rounded-lg border border-surface-200 p-5"><h2 id={id} className="mb-3 text-lg font-semibold text-ink-900">{title}</h2>{children}</section>;
}

/** `base` is `/me/orders/<n>` (owner) or `/orders/<n>` (guest); null for the read-only tracking view. */
export function OrderDetail({ view, base, call, onChange, notice }: { view: CustomerOrderView; base: string | null; call: Call; onChange: (v: CustomerOrderView) => void; notice?: ReactNode }) {
  const [open, setOpen] = useState<'cancel' | 'return' | null>(null);
  const reload = async () => { if (base) onChange(await call<CustomerOrderView>('GET', base)); };
  const invoice = async () => {
    const tab = window.open('', '_blank');
    try { const { url } = await call<{ url: string }>('GET', `${base}/invoice`); if (tab) tab.location.href = url; else window.location.assign(url); }
    catch (e) { tab?.close(); toast.error(message(e)); }
  };
  const t = view.totals;
  const row = (label: string, value: string, strong = false) => <div className={`flex justify-between gap-4 ${strong ? 'font-semibold text-ink-900' : 'text-ink-700'}`}><dt>{label}</dt><dd className="tabular-nums">{value}</dd></div>;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-[28px] font-semibold text-ink-900">Order <span className="font-mono">{view.orderNumber}</span></h1>
          <p className="text-sm text-ink-700">Placed {when(view.placedAt ?? view.createdAt)} · {view.paymentMethod === 'COD' ? 'Cash on delivery' : 'Paid online'}</p>
          <p className="mt-2 inline-flex rounded-full bg-surface-100 px-3 py-1 text-sm font-semibold text-ink-900" aria-label="Order status">{view.displayStatus}</p>
        </div>
        {base && (
          <div className="flex flex-wrap gap-2">
            {view.actions.canDownloadInvoice && <button type="button" className={secondaryButton} onClick={() => void invoice()}>Invoice</button>}
            {view.actions.canRequestReturn && <button type="button" className={secondaryButton} aria-expanded={open === 'return'} onClick={() => setOpen(open === 'return' ? null : 'return')}>Report a problem</button>}
            {view.actions.canCancel && <button type="button" className={secondaryButton} aria-expanded={open === 'cancel'} onClick={() => setOpen(open === 'cancel' ? null : 'cancel')}>Cancel order</button>}
          </div>
        )}
      </div>
      {notice}
      {base && open === 'cancel' && <CancelPanel view={view} base={base} call={call} onDone={async () => { setOpen(null); await reload(); }} onClose={() => setOpen(null)} />}
      {base && open === 'return' && <ReturnPanel view={view} base={base} call={call} onDone={async () => { setOpen(null); await reload(); }} onClose={() => setOpen(null)} />}

      <div className="grid gap-5 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Section title="Items" id="o-items">
            <ul className="divide-y divide-surface-100">
              {view.items.map((i) => (
                <li key={i.id} className="flex gap-3 py-3">
                  {i.imageUrl ? <img src={i.imageUrl} alt="" className="h-16 w-16 rounded-md object-cover" /> : <div className="h-16 w-16 rounded-md bg-surface-100" aria-hidden />}
                  <div className="min-w-0 flex-1"><p className="font-medium text-ink-900">{i.name}</p><p className="text-sm text-ink-700">{i.label} · Qty {i.quantity}</p></div>
                  <p className="tabular-nums text-ink-900">{formatINR(i.lineTotal)}</p>
                </li>
              ))}
            </ul>
            <dl className="ml-auto mt-3 max-w-xs space-y-1 text-sm">
              {row('Subtotal', formatINR(t.subtotal))}
              {t.couponDiscount > 0 && row(`Coupon ${t.couponCode ?? ''}`.trim(), `−${formatINR(t.couponDiscount)}`)}
              {row('Shipping', t.shipping ? formatINR(t.shipping) : 'Free')}
              {t.codFee > 0 && row('Cash on delivery fee', formatINR(t.codFee))}
              {row('Total', formatINR(t.total), true)}
              {t.refunded > 0 && row('Refunded', `−${formatINR(t.refunded)}`)}
            </dl>
          </Section>
          {view.returns.length > 0 && (
            <Section title="Your reports" id="o-returns">
              <ul className="space-y-4">
                {view.returns.map((r) => (
                  <li key={r.id} className="text-sm">
                    <p className="font-medium text-ink-900">{RETURN_REASON_LABEL[r.reason as keyof typeof RETURN_REASON_LABEL] ?? r.reason}: {RETURN_STATUS[r.status] ?? r.status}</p>
                    <p className="text-ink-700">{r.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')} · {when(r.createdAt)}</p>
                    {r.note && <p className="mt-1 text-ink-900">From us: {r.note}</p>}
                    {r.photos.length > 0 && <ul className="mt-2 flex flex-wrap gap-2">{r.photos.map((p, n) => <li key={p.id}><a href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt={`Your photo ${n + 1}`} className="h-16 w-16 rounded-md object-cover" /></a></li>)}</ul>}
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {view.timeline.length > 0 && (
            <Section title="Timeline" id="o-timeline">
              <ol className="space-y-2 text-sm">{[...view.timeline].reverse().map((e, n) => <li key={n} className="flex flex-wrap justify-between gap-2"><span className="font-medium text-ink-900">{e.label}</span><time dateTime={e.at} className="text-ink-700">{when(e.at)}</time></li>)}</ol>
            </Section>
          )}
        </div>
        <div className="space-y-5">
          <Section title="Delivery" id="o-delivery">
            <address className="text-sm not-italic text-ink-900">
              <span className="block font-medium">{view.shippingAddress.name}</span>
              {view.shippingAddress.lines.map((l) => <span key={l} className="block">{l}</span>)}
              <span className="block">Phone {view.shippingAddress.phone}</span>
            </address>
            {view.shipment && (
              <p className="mt-3 text-sm text-ink-900">{view.shipment.courierName} · <span className="font-mono">{view.shipment.awbNumber}</span>
                {view.shipment.trackingUrl && <> · <a className={textLink} href={view.shipment.trackingUrl} target="_blank" rel="noreferrer">Track the parcel</a></>}</p>
            )}
            {view.returnDeadline && view.actions.canRequestReturn && <p className="mt-3 text-sm text-ink-700">Something wrong? Report it by {when(view.returnDeadline)}.</p>}
          </Section>
          {view.refunds.length > 0 && (
            <Section title="Refunds" id="o-refunds">
              <ul className="space-y-1 text-sm">{view.refunds.map((r, n) => <li key={n} className="flex justify-between gap-2"><span>{r.status} · {when(r.processedAt ?? r.createdAt)}</span><span className="tabular-nums">{formatINR(r.amount)}</span></li>)}</ul>
              <p className="mt-2 text-xs text-ink-700">Online refunds usually reach your account in 5–7 working days.</p>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

function CancelPanel({ view, base, call, onDone, onClose }: { view: CustomerOrderView; base: string; call: Call; onDone: () => Promise<void>; onClose: () => void }) {
  const [key] = useState(() => crypto.randomUUID());
  const [problem, setProblem] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<z.input<typeof customerCancelOrderBody>, unknown, z.output<typeof customerCancelOrderBody>>({ resolver: zodResolver(customerCancelOrderBody), defaultValues: { reason: '' } });
  const money = view.paymentMethod === 'COD' || view.status === 'PENDING_PAYMENT' ? 'You won’t be charged.' : `${formatINR(view.totals.total - view.totals.refunded)} is refunded to your original payment method in 5–7 working days.`;
  const save = handleSubmit(async (body) => {
    setProblem(null);
    try { await call('POST', `${base}/cancel`, body, { 'Idempotency-Key': key }); toast.success(`Order ${view.orderNumber} cancelled`); await onDone(); }
    catch (e) { if (!applyServerErrors(e, setError, ['reason'])) setProblem(message(e)); }
  });
  return (
    <section aria-labelledby="cancel-h" className="rounded-lg border border-danger-700 p-5">
      <h2 id="cancel-h" className="text-lg font-semibold text-ink-900">Cancel this order?</h2>
      <p className="mt-1 text-sm text-ink-700">{money}</p>
      <form noValidate onSubmit={(e) => { void save(e); }} className="mt-4 space-y-3">
        <TextField id="c-reason" label="Why are you cancelling? (optional)" {...register('reason')} error={errors.reason?.message} />
        {problem && <FormAlert>{problem}</FormAlert>}
        <div className="flex flex-wrap gap-3"><button type="submit" className={dangerButton} disabled={isSubmitting}>{isSubmitting ? 'Cancelling…' : 'Cancel order'}</button><button type="button" className={secondaryButton} onClick={onClose}>Keep my order</button></div>
      </form>
    </section>
  );
}

type Photo = { id: number | null; name: string; status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED'; error?: string };
type ReturnForm = { reason: CustomerReturnInput['reason'] | ''; description: string; quantities: string[]; mediaIds: number[] };

function ReturnPanel({ view, base, call, onDone, onClose }: { view: CustomerOrderView; base: string; call: Call; onDone: () => Promise<void>; onClose: () => void }) {
  const [key] = useState(() => crypto.randomUUID());
  const [problem, setProblem] = useState<string | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const items = view.items.filter((i) => i.returnableQty > 0);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  // The form keeps quantities as typed; the shared schema checks the body built from them (items with a quantity).
  const toBody = (v: ReturnForm) => ({ reason: v.reason, description: v.description, mediaIds: v.mediaIds,
    items: items.flatMap((i, n) => (v.quantities[n]?.trim() ? [{ orderItemId: i.id, quantity: /^\d+$/.test(v.quantities[n]!.trim()) ? Number(v.quantities[n]) : Number.NaN }] : [])) });
  const resolver = zodResolver(z.custom<ReturnForm>().transform((v, ctx) => {
    const r = customerReturnBody.safeParse(toBody(v));
    if (r.success) return r.data;
    for (const i of r.error.issues) {
      const [first, n, field] = i.path as (string | number)[];
      // items.<k>.quantity in the body → quantities.<row> in the form (the body lists only the rows with a quantity).
      const rows = items.map((_, row) => row).filter((row) => v.quantities[row]?.trim());
      ctx.addIssue({ code: 'custom', message: i.message, path: first === 'items' && typeof n === 'number' && field ? ['quantities', rows[n] ?? 0] : first === 'items' ? ['quantities'] : [first ?? ''] });
    }
    return z.NEVER;
  }));
  const { register, handleSubmit, setError, setValue, control, formState: { errors, isSubmitting } } = useForm<ReturnForm, unknown, z.output<typeof customerReturnBody>>({
    resolver: resolver as never, defaultValues: { reason: '', description: '', quantities: items.map(() => ''), mediaIds: [] },
  });
  const reason = useWatch({ control, name: 'reason' });
  const busy = photos.some((p) => p.status === 'UPLOADING' || p.status === 'PROCESSING');
  useEffect(() => { setValue('mediaIds', photos.filter((p) => p.status === 'READY' && p.id !== null).map((p) => p.id!)); }, [photos, setValue]);

  const upload = async (file: File) => {
    const update = (patch: Partial<Photo>) => setPhotos((ps) => ps.map((p) => (p.name === file.name ? { ...p, ...patch } : p)));
    setPhotos((ps) => [...ps.filter((p) => p.name !== file.name), { id: null, name: file.name, status: 'UPLOADING' }]);
    try {
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(file.type)) throw new Error('Use a JPEG, PNG, WebP or AVIF photo');
      if (file.size > 8 * 1024 * 1024) throw new Error('Photos can be at most 8 MB');
      const p = await call<{ media: { id: number }; upload: { url: string; headers: Record<string, string> } }>('POST', `${base}/uploads/presign`, { filename: file.name, contentType: file.type, size: file.size });
      const put = await fetch(p.upload.url, { method: 'PUT', body: file, headers: { 'Content-Type': p.upload.headers['Content-Type'] ?? file.type } });
      if (!put.ok) throw new Error('The upload failed. Try again.');
      await call('POST', `${base}/uploads/${p.media.id}/complete`, {});
      update({ id: p.media.id, status: 'PROCESSING' });
      for (let i = 0; i < 40 && live.current; i++) {                       // the worker checks and resizes it (a few seconds)
        const { media } = await call<{ media: { status: string; failureReason: string | null } }>('GET', `${base}/uploads/${p.media.id}`);
        if (media.status === 'READY') { update({ status: 'READY' }); return; }
        if (media.status === 'REJECTED') throw new Error('This file isn’t a photo we can use.');
        await new Promise((r) => setTimeout(r, 1500));
      }
      throw new Error('The photo is taking too long. Try again.');
    } catch (e) { update({ status: 'FAILED', error: message(e) }); }
  };

  const save = handleSubmit(async (body) => {
    setProblem(null);
    try { await call('POST', `${base}/returns`, body, { 'Idempotency-Key': key }); toast.success('We’ve received your report and will email you within 2 working days.'); await onDone(); }
    catch (e) {
      if (e instanceof ApiError && Array.isArray(e.details)) {
        for (const d of e.details as { path?: string }[]) {
          const m = /^items\.(\d+)\.quantity$/.exec(d.path ?? '');
          if (m) { const id = body.items[Number(m[1])]?.orderItemId; d.path = `quantities.${items.findIndex((i) => i.id === id)}`; }
        }
      }
      if (applyServerErrors(e, setError, ['reason', 'description', 'mediaIds', ...items.map((_, n) => `quantities.${n}` as const)])) return;
      setProblem(message(e));
    }
  });
  const photoError = errors.mediaIds?.message;
  // An issue on the whole list: RHF keeps it on `quantities.root` (field array), or `quantities` from the server.
  const q = errors.quantities as { message?: string; root?: { message?: string } } | undefined;
  const listError = q?.root?.message ?? q?.message;
  return (
    <section aria-labelledby="return-h" className="rounded-lg border border-surface-200 p-5">
      <h2 id="return-h" className="text-lg font-semibold text-ink-900">Report a problem</h2>
      <p className="mt-1 text-sm text-ink-700">For items that arrived damaged, wrong, defective or missing. We’ll reply within 2 working days.</p>
      <form noValidate onSubmit={(e) => { void save(e); }} className="mt-4 space-y-4">
        <SelectField id="r-reason" label="What went wrong?" {...register('reason')} error={errors.reason?.message}>
          <option value="">Choose…</option>
          {RETURN_REASONS.map((r) => <option key={r} value={r}>{RETURN_REASON_LABEL[r]}</option>)}
        </SelectField>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink-900">Which items, and how many?</legend>
          {items.map((i, n) => <TextField key={i.id} id={`r-q-${n}`} label={`${i.name} (${i.label}), up to ${i.returnableQty}`} inputMode="numeric" placeholder="0" {...register(`quantities.${n}`)} error={errors.quantities?.[n]?.message} />)}
          {listError && <p className="text-sm text-danger-700">{listError}</p>}
        </fieldset>
        <div>
          <label htmlFor="r-desc" className="block text-sm font-medium text-ink-900">Tell us more (optional)</label>
          <textarea id="r-desc" rows={3} className="mt-1 block w-full rounded-md border border-border-input p-2 text-sm" aria-invalid={errors.description ? true : undefined} aria-describedby={errors.description ? 'r-desc-error' : undefined} {...register('description')} />
          {errors.description && <p id="r-desc-error" className="mt-1 text-sm text-danger-700">{errors.description.message}</p>}
        </div>
        <div>
          <label htmlFor="r-photos" className="block text-sm font-medium text-ink-900">Photos {reason === 'MISSING_ITEM' ? '(optional)' : '(at least one)'}</label>
          <input id="r-photos" type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple className="mt-1 block text-sm"
            aria-invalid={photoError ? true : undefined} aria-describedby={photoError ? 'r-photos-error' : undefined}
            onChange={(e) => { for (const f of Array.from(e.target.files ?? []).slice(0, 6)) void upload(f); e.target.value = ''; }} />
          {photoError && <p id="r-photos-error" className="mt-1 text-sm text-danger-700">{photoError}</p>}
          {photos.length > 0 && <ul className="mt-2 space-y-1 text-sm" aria-live="polite">{photos.map((p) => <li key={p.name} className={p.status === 'FAILED' ? 'text-danger-700' : 'text-ink-700'}>{p.name}: {p.status === 'READY' ? 'ready' : p.status === 'FAILED' ? p.error : 'uploading…'}</li>)}</ul>}
        </div>
        {problem && <FormAlert>{problem}</FormAlert>}
        <div className="flex flex-wrap gap-3"><button type="submit" className={primaryButton} disabled={isSubmitting || busy}>{isSubmitting ? 'Sending…' : busy ? 'Uploading photos…' : 'Send report'}</button><button type="button" className={secondaryButton} onClick={onClose}>Close</button></div>
      </form>
    </section>
  );
}
