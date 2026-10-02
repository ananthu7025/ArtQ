// Variant drawer (product.md §7.3): inline edit of non-commercial fields; price/MRP only with pricing:write (otherwise
// read-only with a lock); stock as on hand / reserved / available with a link to Inventory.
// Validation = the API's schemas (variantContent fields, pricingBody) after turning rupees into paise.
import { formatINR, pricingBody, variantContent } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, X } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { z } from 'zod';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { btn, VersionConflictDialog } from '../../components/dialogs';
import { applyServerErrors, FormAlert, SelectField, TextField } from '../../components/form';

export type Variant = {
  id: number; sku: string; label: string; size: string | null; color: string | null; weightG: number | null; weightSource: 'MEASURED' | 'ESTIMATED' | null;
  price: number | null; mrp: number | null; onHand: number; reserved: number; available: number; isActive: boolean; version: number;
};
type ProductDetail = { id: number; name: string; status: string; variants: Variant[] };

const RUPEES = /^\d{1,7}(\.\d{1,2})?$/;
const toPaise = (s: string) => (s.trim() === '' ? null : Math.round(Number(s) * 100));
const fromPaise = (p: number | null) => (p === null ? '' : (p / 100).toFixed(2).replace(/\.00$/, ''));

/** Form schema: the API's own field rules, plus the rupee format of the price inputs (client-only representation). */
function variantForm(canPrice: boolean, version: number) {
  return z.object({
    label: variantContent.shape.label,
    color: z.string().transform((s) => (s.trim() === '' ? null : s)).pipe(variantContent.shape.color.unwrap()),
    weightG: variantContent.shape.weightG,
    weightSource: variantContent.shape.weightSource,
    isActive: z.boolean(),
    price: z.string(),
    mrp: z.string(),
  }).superRefine((v, ctx) => {
    if (!canPrice) return;
    for (const k of ['price', 'mrp'] as const) {
      if (v[k].trim() !== '' && !RUPEES.test(v[k].trim())) ctx.addIssue({ code: 'custom', path: [k], message: 'Use rupees with at most two decimals, e.g. 899 or 899.50' });
    }
    if (v.price.trim() === '') { ctx.addIssue({ code: 'custom', path: ['price'], message: 'Enter a price' }); return; }
    const r = pricingBody.safeParse({ price: toPaise(v.price), mrp: toPaise(v.mrp), version });
    if (!r.success) for (const i of r.error.issues) ctx.addIssue({ code: 'custom', path: i.path, message: i.message });
  });
}
type FormIn = z.input<ReturnType<typeof variantForm>>;
type FormOut = z.output<ReturnType<typeof variantForm>>;

function VariantRowEditor({ v, canPrice, onDone, onConflict }: { v: Variant; canPrice: boolean; onDone: () => void; onConflict: () => void }) {
  const { api } = useAuth();
  const qc = useQueryClient();
  const [error, setError] = useState<{ message: string; fixes?: { check: string; fix: string }[] } | null>(null);
  const { register, handleSubmit, setError: setFieldError, formState: { errors, isSubmitting, dirtyFields } } = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(variantForm(canPrice, v.version)),
    defaultValues: { label: v.label, color: v.color ?? '', weightG: v.weightG, weightSource: v.weightSource, isActive: v.isActive, price: fromPaise(v.price), mrp: fromPaise(v.mrp) },
  });
  const submit = handleSubmit(async (values) => {
    setError(null);
    const content = Object.fromEntries((['label', 'color', 'weightG', 'weightSource', 'isActive'] as const).filter((k) => dirtyFields[k]).map((k) => [k, values[k]]));
    try {
      let version = v.version;
      if (Object.keys(content).length) version = (await api.request<Variant>('PATCH', `/admin/variants/${v.id}`, { body: { ...content, version } })).version;
      if (canPrice && (dirtyFields.price || dirtyFields.mrp)) {
        await api.request('PATCH', `/admin/variants/${v.id}/pricing`, { body: { price: toPaise(values.price), mrp: toPaise(values.mrp), version } });
      }
      await qc.invalidateQueries({ queryKey: ['product'] });
      await qc.invalidateQueries({ queryKey: ['products'] });
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') { onConflict(); return; }
      if (applyServerErrors(e, setFieldError, ['label', 'color', 'weightG', 'weightSource', 'isActive', 'price', 'mrp'])) return;
      const fixes = e instanceof ApiError ? (e.details as { failures?: { check: string; fix: string }[] } | undefined)?.failures : undefined;
      setError({ message: e instanceof Error ? e.message : 'Something went wrong', ...(fixes ? { fixes } : {}) });
    }
  });
  const id = (f: string) => `v${v.id}-${f}`;
  return (
    <form className="grid gap-3 rounded-md border border-surface-200 bg-surface-50 p-3 sm:grid-cols-2" noValidate onSubmit={(e) => { void submit(e); }} aria-label={`Edit ${v.sku}`}>
      <TextField id={id('label')} label="Label" {...register('label')} error={errors.label?.message} />
      <TextField id={id('color')} label="Colour" {...register('color')} error={errors.color?.message} />
      <TextField id={id('weight')} label="Weight (g)" inputMode="numeric" {...register('weightG', { setValueAs: (s) => (s === '' || s === null ? null : Number(s)) })} error={errors.weightG?.message} />
      <SelectField id={id('weight-source')} label="Weight is" {...register('weightSource', { setValueAs: (s) => (s === '' ? null : s) })} error={errors.weightSource?.message}>
        <option value="">Not set</option><option value="MEASURED">Measured</option><option value="ESTIMATED">Estimated</option>
      </SelectField>
      {canPrice && <>
        <TextField id={id('price')} label="Price (₹)" inputMode="decimal" {...register('price')} error={errors.price?.message} />
        <TextField id={id('mrp')} label="MRP (₹, optional)" inputMode="decimal" {...register('mrp')} error={errors.mrp?.message} />
      </>}
      <label className="flex items-center gap-2 text-sm text-ink-900 sm:col-span-2"><input type="checkbox" className="h-4 w-4 accent-brand-700" {...register('isActive')} /> Active (sold on the storefront)</label>
      {error && (
        <div className="sm:col-span-2"><FormAlert>{error.message}{error.fixes && <ul className="mt-1 list-disc pl-5">{error.fixes.map((f) => <li key={f.check}>{f.check}: {f.fix}</li>)}</ul>}</FormAlert></div>
      )}
      <div className="flex justify-end gap-3 sm:col-span-2">
        <button type="button" className={`${btn} text-ink-900 hover:bg-surface-100`} onClick={onDone}>Cancel</button>
        <button type="submit" disabled={isSubmitting} aria-busy={isSubmitting || undefined} className={`${btn} bg-brand-700 text-white disabled:opacity-80`}>{isSubmitting ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

export function VariantDrawer({ productId, onClose, canWrite, canPrice }: { productId: number; onClose: () => void; canWrite: boolean; canPrice: boolean }) {
  const { api } = useAuth();
  const [editing, setEditing] = useState<number | null>(null);
  const [conflict, setConflict] = useState(false);
  const q = useQuery({ queryKey: ['product', productId], queryFn: () => api.request<ProductDetail>('GET', `/admin/products/${productId}`) });
  const money = (p: number | null) => (p === null ? '—' : formatINR(p));
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-[min(100vw,720px)] flex-col bg-white shadow-xl outline-none" aria-describedby={undefined}>
          <header className="flex items-center justify-between border-b border-surface-200 px-5 py-4">
            <Dialog.Title className="text-lg font-semibold text-ink-900">Variants{q.data ? ` of ${q.data.name}` : ''}</Dialog.Title>
            <Dialog.Close className="inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-surface-100" aria-label="Close"><X aria-hidden size={20} /></Dialog.Close>
          </header>
          <div className="flex-1 overflow-y-auto p-5">
            {q.isPending && <p className="text-ink-700">Loading…</p>}
            {q.isError && <FormAlert>Couldn&apos;t load the variants. {q.error instanceof Error ? q.error.message : ''}</FormAlert>}
            {q.data && q.data.variants.length === 0 && <p className="text-ink-700">No variants yet. Add them in the editor.</p>}
            <ul className="space-y-3">
              {q.data?.variants.map((v) => (
                <li key={v.id} className="rounded-md border border-surface-200 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-ink-900">{v.label} <span className="text-sm font-normal text-ink-700">{v.sku}</span>{!v.isActive && <span className="ml-2 rounded-full bg-surface-100 px-2 py-0.5 text-xs text-ink-700">Inactive</span>}</p>
                      <p className="text-sm text-ink-700">{[v.size, v.color, v.weightG ? `${v.weightG} g ${v.weightSource === 'MEASURED' ? '(measured)' : v.weightSource === 'ESTIMATED' ? '(estimated)' : ''}` : 'No weight'].filter(Boolean).join(' · ')}</p>
                    </div>
                    <dl className="grid grid-cols-2 gap-x-4 text-sm tabular-nums sm:grid-cols-4">
                      <div><dt className="text-ink-700">Price</dt><dd className="flex items-center gap-1 text-ink-900">{money(v.price)}{!canPrice && <Lock aria-label="Price is read-only for your role" size={14} className="text-ink-700" />}</dd></div>
                      <div><dt className="text-ink-700">MRP</dt><dd className="flex items-center gap-1 text-ink-900">{money(v.mrp)}{!canPrice && <Lock aria-label="MRP is read-only for your role" size={14} className="text-ink-700" />}</dd></div>
                      <div><dt className="text-ink-700">On hand / reserved</dt><dd className="text-ink-900">{v.onHand} / {v.reserved}</dd></div>
                      <div><dt className="text-ink-700">Available</dt><dd className={v.available === 0 ? 'font-semibold text-danger-700' : 'text-ink-900'}>{v.available} <Link to={`/inventory?q=${encodeURIComponent(v.sku)}`} className="text-brand-700 underline">Inventory</Link></dd></div>
                    </dl>
                  </div>
                  {canWrite && editing !== v.id && <button type="button" className="mt-2 h-11 rounded-md border border-border-input px-4 font-medium text-ink-900 hover:bg-surface-100" onClick={() => setEditing(v.id)} aria-label={`Edit ${v.sku}`}>Edit</button>}
                  {editing === v.id && <div className="mt-3"><VariantRowEditor v={v} canPrice={canPrice} onDone={() => setEditing(null)} onConflict={() => setConflict(true)} /></div>}
                </li>
              ))}
            </ul>
          </div>
          <VersionConflictDialog open={conflict} entity="variant" onReload={() => { setConflict(false); setEditing(null); void q.refetch(); }} onKeepEditing={() => setConflict(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
