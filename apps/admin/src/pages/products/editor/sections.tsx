// Smaller editor sections: tax approval, SEO preview, readiness panel, related products.
import { taxApprovalBody, type ProductListRow } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { Page } from '../../../api/client';
import { useAuth } from '../../../auth/AuthProvider';
import { btn } from '../../../components/dialogs';
import { applyServerErrors, FormAlert, TextField } from '../../../components/form';
import type { ProductPayload } from './schema';

const dateTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

/** Tax (product.md §7.4): HSN + GST %, "Approve tax" by catalog:publish; validated with the API's taxApprovalBody. */
export function TaxSection({ product, canApprove }: { product: ProductPayload; canApprove: boolean }) {
  const { api } = useAuth();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, setError: setFieldError, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(taxApprovalBody),
    values: { hsnCode: product.hsnCode ?? '', gstRate: product.gstRate ?? (undefined as unknown as number) },
  });
  const submit = handleSubmit(async (v) => {
    setError(null);
    try {
      await api.request('POST', `/admin/products/${product.id}/tax-approval`, { body: v });
      toast.success('Tax approved');
      await qc.invalidateQueries({ queryKey: ['product', product.id] });
    } catch (e) { if (!applyServerErrors(e, setFieldError, ['hsnCode', 'gstRate'])) setError(e instanceof Error ? e.message : 'Something went wrong'); }
  });
  return (
    <form noValidate onSubmit={(e) => { void submit(e); }} className="space-y-3" aria-label="Tax">
      <p className="text-sm text-ink-700">
        {product.taxApprovedAt ? <span className="inline-flex items-center gap-1 text-success-700"><Check aria-hidden size={16} /> Approved {dateTime.format(new Date(product.taxApprovedAt))}</span> : 'Not approved yet. Use the HSN code and GST rate your accountant gives you (GST rates changed in September 2025).'}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id="tax-hsn" label="HSN code" inputMode="numeric" disabled={!canApprove} {...register('hsnCode')} error={errors.hsnCode?.message} />
        <TextField id="tax-gst" label="GST rate (%)" inputMode="decimal" disabled={!canApprove} {...register('gstRate', { setValueAs: (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)) })} error={errors.gstRate?.message} />
      </div>
      {error && <FormAlert>{error}</FormAlert>}
      {canApprove ? <button type="submit" disabled={isSubmitting} aria-busy={isSubmitting || undefined} className={`${btn} bg-brand-700 text-white disabled:opacity-80`}>{isSubmitting ? 'Approving…' : 'Approve tax'}</button>
        : <p className="text-sm text-ink-700">Only people who can publish products approve tax.</p>}
    </form>
  );
}

/** Search-result preview: title ≈ 60 characters, description ≈ 155 (beyond that search engines cut it). */
export function SeoPreview({ title, description, slug }: { title: string; description: string; slug: string }) {
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
  return (
    <div className="rounded-md border border-surface-200 bg-white p-3" aria-label="Search result preview">
      <p className="text-xs text-ink-700">artq.in › product › {slug || 'your-product'}</p>
      <p className="text-lg text-[#1a0dab]">{cut(title || 'Product name', 60)}</p>
      <p className="text-sm text-ink-700">{cut(description || 'Add an SEO description, or the short description is used.', 155)}</p>
    </div>
  );
}

export function ReadinessPanel({ product }: { product: ProductPayload }) {
  const r = product.readiness;
  return (
    <section aria-labelledby="readiness-title" className="rounded-lg border border-surface-200 bg-white p-4">
      <h2 id="readiness-title" className="font-semibold text-ink-900">Ready to publish?</h2>
      {r.ready ? <p className="mt-2 flex items-center gap-2 text-success-700"><Check aria-hidden size={18} /> Every check passes.</p> : (
        <>
          <p className="mt-1 text-sm text-ink-700">{r.failures.length} check{r.failures.length > 1 ? 's' : ''} to fix:</p>
          <ul className="mt-2 space-y-2 text-sm">{r.failures.map((f) => <li key={f.code}><span className="font-semibold text-ink-900">{f.check}:</span> <span className="text-ink-700">{f.fix}</span></li>)}</ul>
        </>
      )}
    </section>
  );
}

type Rel = { productId: number; kind: 'FREQUENTLY_BOUGHT_TOGETHER' | 'SIMILAR'; name: string };
const KIND = { FREQUENTLY_BOUGHT_TOGETHER: 'Frequently bought together', SIMILAR: 'Similar products' } as const;

/** Related products: search by name or SKU, add to a list, reorder, remove. Saved with the product. */
export function RelationsField({ productId, value, onChange, disabled }: { productId: number; value: Rel[]; onChange: (v: Rel[]) => void; disabled: boolean }) {
  const { api } = useAuth();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<Rel['kind']>('FREQUENTLY_BOUGHT_TOGETHER');
  const search = useQuery({
    queryKey: ['product-search', q], enabled: q.trim().length >= 2,
    queryFn: () => api.request<Page<ProductListRow>>('GET', '/admin/products', { query: { q: q.trim(), limit: 8, sort: 'name' } }),
  });
  const results = (search.data?.data ?? []).filter((p) => p.id !== productId && !value.some((v) => v.productId === p.id && v.kind === kind));
  const move = (i: number, d: -1 | 1) => { const next = [...value]; const [x] = next.splice(i, 1); next.splice(i + d, 0, x!); onChange(next); };
  return (
    <div className="space-y-3">
      {(['FREQUENTLY_BOUGHT_TOGETHER', 'SIMILAR'] as const).map((k) => {
        const list = value.map((v, i) => ({ v, i })).filter(({ v }) => v.kind === k);
        return (
          <div key={k}>
            <h3 className="text-sm font-semibold text-ink-900">{KIND[k]}</h3>
            {list.length === 0 ? <p className="text-sm text-ink-700">None yet.</p> : (
              <ol className="mt-1 space-y-1">
                {list.map(({ v, i }, n) => (
                  <li key={`${v.kind}-${v.productId}`} className="flex items-center gap-2 rounded border border-surface-200 px-2 py-1 text-sm">
                    <span className="flex-1 text-ink-900">{v.name}</span>
                    {!disabled && <>
                      <button type="button" className="inline-flex h-8 w-8 items-center justify-center rounded hover:bg-surface-100 disabled:opacity-40" disabled={n === 0} onClick={() => move(i, -1)} aria-label={`Move ${v.name} up`}><ArrowUp aria-hidden size={14} /></button>
                      <button type="button" className="inline-flex h-8 w-8 items-center justify-center rounded hover:bg-surface-100 disabled:opacity-40" disabled={n === list.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${v.name} down`}><ArrowDown aria-hidden size={14} /></button>
                      <button type="button" className="inline-flex h-8 w-8 items-center justify-center rounded text-danger-700 hover:bg-surface-100" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove ${v.name} from ${KIND[k].toLowerCase()}`}><Trash2 aria-hidden size={14} /></button>
                    </>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        );
      })}
      {!disabled && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm text-ink-900">Add to
            <select className="mt-1 block h-11 rounded-md border border-border-input bg-white px-3" value={kind} onChange={(e) => setKind(e.target.value as Rel['kind'])}>
              <option value="FREQUENTLY_BOUGHT_TOGETHER">{KIND.FREQUENTLY_BOUGHT_TOGETHER}</option><option value="SIMILAR">{KIND.SIMILAR}</option>
            </select>
          </label>
          <label className="text-sm text-ink-900">Find a product
            <input className="mt-1 block h-11 w-64 rounded-md border border-border-input px-3" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or SKU" />
          </label>
        </div>
      )}
      {results.length > 0 && (
        <ul className="rounded-md border border-surface-200" aria-label="Search results">
          {results.map((p) => (
            <li key={p.id}><button type="button" className="flex h-10 w-full items-center px-3 text-left text-sm hover:bg-surface-100" onClick={() => { onChange([...value, { productId: p.id, kind, name: p.name }]); setQ(''); }}>Add “{p.name}”</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}
