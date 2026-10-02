// Product editor (product.md §7.4, task 2.5). Content sections (Basics, Descriptions, Relations, Flags & ranks, SEO) are
// one form saved with the product `version`; Media, Variants and Tax save on their own. A save refused because someone
// else saved first shows who and when, with Reload or Compare (CLAUDE.md "Validation rule" applies to every field).
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { ApiError } from '../../../api/client';
import { useAuth } from '../../../auth/AuthProvider';
import { btn, FormDialog } from '../../../components/dialogs';
import { errorMessage } from '../../../components/feedback';
import { applyServerErrors, FormAlert, SelectField, TextField } from '../../../components/form';
import { PageHeader } from '../../simple';
import type { CategoryOption, TypeOption } from '../AddProductDialog';
import { PublishToggle, StatusPill } from '../parts';
import { MediaSection } from './MediaSection';
import { RichText } from './RichText';
import { editorForm, FIELD_LABELS, toForm, type EditorFormIn, type EditorFormOut, type ProductPayload } from './schema';
import { ReadinessPanel, RelationsField, SeoPreview, TaxSection } from './sections';
import { VariantsGrid } from './VariantsGrid';

// In page order: the content form (saved together), then the sections that save on their own.
const SECTIONS = [['basics', 'Basics'], ['descriptions', 'Descriptions'], ['relations', 'Relations'], ['flags', 'Flags & ranks'], ['seo', 'SEO'], ['media', 'Media'], ['variants', 'Variants'], ['tax', 'Tax']] as const;
const time = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' });
const area = 'mt-1 block w-full rounded-md border border-border-input bg-white px-3 py-2 text-ink-900';
const toId = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v));
const toInt = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v));

function Section({ id, title, children, note }: { id: string; title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 rounded-lg border border-surface-200 bg-white p-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${id}-title`} className="text-lg font-semibold text-ink-900">{title}</h2>
        {note && <span className="text-sm text-ink-700">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function TextArea({ id, label, error, hint, rows = 4, ...rest }: { id: string; label: string; error?: string | undefined; hint?: string; rows?: number } & React.TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: React.Ref<HTMLTextAreaElement> }) {
  const described = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink-900">{label}</label>
      <textarea id={id} rows={rows} {...rest} aria-invalid={error ? true : undefined} aria-describedby={described} className={area} />
      {error && <p id={`${id}-error`} className="mt-1 text-sm text-danger-700">{error}</p>}
      {hint && <p id={`${id}-hint`} className="mt-1 text-sm text-ink-700">{hint}</p>}
    </div>
  );
}

type Conflict = { current: ProductPayload; mine: EditorFormIn };

function ConflictDialog({ conflict, onReload, onKeepMine, onClose }: { conflict: Conflict; onReload: () => void; onKeepMine: () => void; onClose: () => void }) {
  const [compare, setCompare] = useState(false);
  const theirs = toForm(conflict.current);
  const who = conflict.current.updatedBy?.name ?? conflict.current.updatedBy?.email ?? 'someone';
  const at = new Date(conflict.current.updatedAt);
  const fmt = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === 'object' && x ? ('name' in x ? (x as { name: string }).name : JSON.stringify(x)) : String(x))).join(', ') : v === null || v === '' ? '(empty)' : String(v));
  const diffs = (Object.keys(FIELD_LABELS) as (keyof EditorFormIn)[]).filter((k) => JSON.stringify(theirs[k]) !== JSON.stringify(conflict.mine[k]));
  return (
    <FormDialog open onOpenChange={(o) => { if (!o) onClose(); }} title={`This product was changed by ${who} at ${time.format(at)}`}
      description={`Your changes were not saved (${day.format(at)}). Reload to start from their version, or compare to decide.`}>
      {compare && (
        <div className="max-h-72 overflow-y-auto">
          {diffs.length === 0 ? <p className="text-sm text-ink-700">Your content matches theirs; they changed something else (images, variants or tax).</p> : (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Differences</caption>
              <thead><tr className="text-ink-700"><th scope="col" className="py-1 pr-2">Field</th><th scope="col" className="py-1 pr-2">Yours</th><th scope="col" className="py-1">Theirs</th></tr></thead>
              <tbody>{diffs.map((k) => <tr key={k} className="border-t border-surface-200 align-top"><th scope="row" className="py-1 pr-2 font-medium text-ink-900">{FIELD_LABELS[k]}</th><td className="max-w-40 break-words py-1 pr-2">{fmt(conflict.mine[k])}</td><td className="max-w-40 break-words py-1">{fmt(theirs[k])}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      )}
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        {!compare && <button type="button" className={`${btn} text-ink-900 hover:bg-surface-100`} onClick={() => setCompare(true)}>Compare</button>}
        {compare && <button type="button" className={`${btn} border border-border-input text-ink-900 hover:bg-surface-100`} onClick={onKeepMine}>Keep mine (save over theirs)</button>}
        <button type="button" className={`${btn} bg-brand-700 text-white`} onClick={onReload}>Reload their version</button>
      </div>
    </FormDialog>
  );
}

function ContentForm({ product, types, categories, techniques, canWrite }: { product: ProductPayload; types: TypeOption[]; categories: CategoryOption[]; techniques: { id: number; name: string }[]; canWrite: boolean }) {
  const { api } = useAuth();
  const qc = useQueryClient();
  // The version this form's edits are based on (sent with the save; a newer one on the server means a conflict).
  const baseVersion = useRef(product.version);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const form = useForm<EditorFormIn, unknown, EditorFormOut>({ resolver: zodResolver(editorForm), defaultValues: toForm(product) });
  const { register, control, handleSubmit, reset, getValues, setValue, setError: setFieldError, formState: { errors, isDirty, isSubmitting } } = form;
  const specs = useFieldArray({ control, name: 'specifications' });
  const [typeId, name, slug, metaTitle, metaDescription, shortDescription, dataFlags] = useWatch({ control, name: ['typeId', 'name', 'slug', 'metaTitle', 'metaDescription', 'shortDescription', 'dataFlags'] });

  // Fresh server data (after a save, or a refetch) becomes the form's base while the form has no unsaved edits. With
  // unsaved edits the base stays, so someone else's newer save is reported as a conflict instead of overwritten.
  useEffect(() => { if (!isDirty) { baseVersion.current = product.version; reset(toForm(product)); } }, [product, isDirty, reset]);
  useEffect(() => {
    if (!isDirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty]);

  const save = async (values: EditorFormOut) => {
    setError(null);
    try {
      const saved = await api.request<ProductPayload>('PATCH', `/admin/products/${product.id}`, { body: { ...values, version: baseVersion.current } });
      baseVersion.current = saved.version;
      reset(toForm(saved));
      qc.setQueryData(['product', product.id], saved);
      await qc.invalidateQueries({ queryKey: ['products'] });
      toast.success('Product saved');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') { setConflict({ current: (e.details as { current: ProductPayload }).current, mine: getValues() }); return; }
      const fields = Object.keys(FIELD_LABELS) as (keyof EditorFormIn)[];
      if (applyServerErrors(e, setFieldError, fields)) return;
      const fixes = e instanceof ApiError ? (e.details as { failures?: { check: string; fix: string }[] } | undefined)?.failures : undefined;
      setError(fixes ? `${errorMessage(e)} ${fixes.map((f) => `${f.check}: ${f.fix}`).join(' ')}` : errorMessage(e));
    }
  };
  const msg = (k: keyof EditorFormIn) => (errors[k] as { message?: string } | undefined)?.message;
  const shownCategories = categories.filter((c) => typeId === null || typeId === undefined || c.typeId === typeId);
  const typeField = register('typeId', { setValueAs: toId, onChange: () => setValue('categoryId', null, { shouldDirty: true }) });

  return (
    <form noValidate onSubmit={(e) => { void handleSubmit(save)(e); }} className="space-y-4" aria-label="Product content">
      <fieldset disabled={!canWrite} className="space-y-4">
        <Section id="basics" title="Basics">
          <div className="grid gap-4 md:grid-cols-2">
            <TextField id="f-name" label="Name" {...register('name')} error={msg('name')} />
            <TextField id="f-slug" label="URL slug" {...register('slug')} error={msg('slug')} hint={`artq.in/product/${slug || '…'}. Changing it keeps the old address working (redirect).`} />
            <SelectField id="f-type" label="Product type" {...typeField} error={msg('typeId')}>
              <option value="">Unassigned</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </SelectField>
            <SelectField id="f-category" label="Category" {...register('categoryId', { setValueAs: toId })} error={msg('categoryId')} hint={typeId ? undefined : 'Choosing a category also sets its type.'}>
              <option value="">None</option>{shownCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </SelectField>
          </div>
          <fieldset className="mt-4">
            <legend className="text-sm font-medium text-ink-900">Techniques</legend>
            <Controller control={control} name="techniqueIds" render={({ field }) => (
              <div className="mt-1 flex flex-wrap gap-x-5 gap-y-2">
                {techniques.length === 0 && <span className="text-sm text-ink-700">No techniques yet (Techniques module).</span>}
                {techniques.map((t) => (
                  <label key={t.id} className="flex items-center gap-2 text-sm text-ink-900">
                    <input type="checkbox" className="h-4 w-4 accent-brand-700" checked={field.value.includes(t.id)} onChange={(e) => field.onChange(e.target.checked ? [...field.value, t.id] : field.value.filter((x) => x !== t.id))} />{t.name}
                  </label>
                ))}
              </div>
            )} />
            {msg('techniqueIds') && <p className="mt-1 text-sm text-danger-700">{msg('techniqueIds')}</p>}
          </fieldset>
        </Section>

        <Section id="descriptions" title="Descriptions">
          <div className="space-y-4">
            <TextArea id="f-short" label="Short description" rows={2} {...register('shortDescription')} error={msg('shortDescription')} hint="One or two sentences for listings, up to 300 characters." />
            <Controller control={control} name="description" render={({ field }) => <RichText id="f-description" label="Description" value={field.value} onChange={field.onChange} error={msg('description')} />} />
            <div className="grid gap-4 md:grid-cols-2">
              <TextArea id="f-details" label="Product details (one per line)" {...register('productDetails')} error={msg('productDetails')} />
              <TextArea id="f-care" label="Specifications & care (one per line)" {...register('specificationsCare')} error={msg('specificationsCare')} />
            </div>
            <TextArea id="f-howto" label="How to use" {...register('howToUse')} error={msg('howToUse')} />
            <fieldset>
              <legend className="text-sm font-medium text-ink-900">Specifications</legend>
              <div className="mt-1 space-y-2">
                {specs.fields.map((f, i) => (
                  <div key={f.id} className="flex flex-wrap items-end gap-2">
                    <TextField id={`spec-key-${i}`} label={`Name ${i + 1}`} className="w-48" {...register(`specifications.${i}.key`)} />
                    <TextField id={`spec-value-${i}`} label={`Value ${i + 1}`} className="min-w-48 flex-1" {...register(`specifications.${i}.value`)} />
                    <button type="button" className="inline-flex h-11 w-11 items-center justify-center rounded text-danger-700 hover:bg-surface-100" onClick={() => specs.remove(i)} aria-label={`Remove specification ${i + 1}`}><Trash2 aria-hidden size={16} /></button>
                  </div>
                ))}
                <button type="button" className={`${btn} border border-border-input text-ink-900 hover:bg-surface-100`} onClick={() => specs.append({ key: '', value: '' })}>Add specification</button>
                {msg('specifications') && <p className="text-sm text-danger-700">{msg('specifications')}</p>}
              </div>
            </fieldset>
          </div>
        </Section>
      </fieldset>

      <fieldset disabled={!canWrite} className="space-y-4">
        <Section id="relations" title="Relations" note="Shown on the product page">
          <Controller control={control} name="relations" render={({ field }) => <RelationsField productId={product.id} value={field.value} onChange={field.onChange} disabled={!canWrite} />} />
          {msg('relations') && <p className="mt-1 text-sm text-danger-700">{msg('relations')}</p>}
        </Section>

        <Section id="flags" title="Flags & ranks">
          <div className="grid gap-4 md:grid-cols-3">
            <label className="flex items-center gap-2 text-sm text-ink-900"><input type="checkbox" className="h-4 w-4 accent-brand-700" {...register('isNewArrival')} /> New arrival</label>
            <TextField id="f-new-rank" label="New arrival rank" inputMode="numeric" {...register('newArrivalRank', { setValueAs: toInt })} error={msg('newArrivalRank')} />
            <span />
            <label className="flex items-center gap-2 text-sm text-ink-900"><input type="checkbox" className="h-4 w-4 accent-brand-700" {...register('isTrending')} /> Trending</label>
            <TextField id="f-trend-rank" label="Trending rank" inputMode="numeric" {...register('trendingRank', { setValueAs: toInt })} error={msg('trendingRank')} />
            <span />
            <label className="flex items-center gap-2 text-sm text-ink-900"><input type="checkbox" className="h-4 w-4 accent-brand-700" {...register('isFeatured')} /> Featured</label>
            <TextField id="f-sort" label="Sort order" inputMode="numeric" {...register('sortOrder', { setValueAs: (v) => (v === '' ? 0 : Number(v)) })} error={msg('sortOrder')} />
            <TextField id="f-tags" label="Tags (comma-separated)" {...register('tags')} error={msg('tags')} />
          </div>
          <div className="mt-4">
            <h3 className="text-sm font-medium text-ink-900">Import flags</h3>
            {dataFlags.length === 0 ? <p className="text-sm text-ink-700">No open import flags.</p> : (
              <ul className="mt-1 flex flex-wrap gap-2">
                {dataFlags.map((f) => (
                  <li key={f} className="inline-flex items-center gap-2 rounded-full bg-warning-bg px-3 py-1 text-sm text-warning-ink">
                    {f}<button type="button" className="font-semibold underline" onClick={() => setValue('dataFlags', dataFlags.filter((x) => x !== f), { shouldDirty: true })} aria-label={`Mark ${f} as resolved`}>Resolve</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Section>

        <Section id="seo" title="SEO">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-4">
              <TextField id="f-meta-title" label={`SEO title (${(metaTitle ?? '').length}/60 shown)`} {...register('metaTitle')} error={msg('metaTitle')} hint="Leave empty to use the product name." />
              <TextArea id="f-meta-description" label={`SEO description (${(metaDescription ?? '').length}/155 shown)`} rows={3} {...register('metaDescription')} error={msg('metaDescription')} hint="Leave empty to use the short description." />
            </div>
            <SeoPreview title={metaTitle || name} description={metaDescription || shortDescription} slug={slug} />
          </div>
        </Section>
      </fieldset>

      {canWrite && (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-3 border-t border-surface-200 bg-surface-50/95 px-1 py-3 backdrop-blur" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom, 0px))' }}>
          {error && <div className="mr-auto max-w-xl"><FormAlert>{error}</FormAlert></div>}
          {Object.keys(errors).length > 0 && !error && <p className="mr-auto text-sm text-danger-700" role="alert">Some fields need attention. They are marked in red.</p>}
          <span className="text-sm text-ink-700">{isDirty ? 'Unsaved changes' : 'All changes saved'}</span>
          <button type="button" disabled={!isDirty || isSubmitting} className={`${btn} text-ink-900 hover:bg-surface-100 disabled:opacity-60`} onClick={() => reset(toForm(product))}>Discard</button>
          <button type="submit" disabled={!isDirty || isSubmitting} aria-busy={isSubmitting || undefined} className={`${btn} bg-brand-700 text-white disabled:opacity-60`}>{isSubmitting ? 'Saving…' : 'Save product'}</button>
        </div>
      )}
      {conflict && (
        <ConflictDialog conflict={conflict} onClose={() => setConflict(null)}
          onReload={() => { qc.setQueryData(['product', product.id], conflict.current); baseVersion.current = conflict.current.version; reset(toForm(conflict.current)); setConflict(null); }}
          onKeepMine={() => { baseVersion.current = conflict.current.version; setConflict(null); toast('Your version is kept. Save again to replace theirs.'); }} />
      )}
    </form>
  );
}

export function ProductEditorPage() {
  const { api, state } = useAuth();
  const perms = state.status === 'authenticated' ? state.permissions : [];
  const canWrite = perms.includes('catalog:write');
  const canPrice = perms.includes('pricing:write');
  const canPublish = perms.includes('catalog:publish');
  const canMedia = canWrite && perms.includes('media:write');
  const qc = useQueryClient();
  const id = Number(useParams().id);
  const valid = Number.isInteger(id) && id > 0;
  const product = useQuery({
    queryKey: ['product', id], enabled: valid,
    queryFn: () => api.request<ProductPayload>('GET', `/admin/products/${id}`),
    // Uploaded images are processed in the background: poll until none is still processing.
    refetchInterval: (q) => ((q.state.data?.images ?? []).some((i) => !['READY', 'FAILED', 'REJECTED'].includes(i.media.status)) ? 3000 : false),
  });
  const types = useQuery({ queryKey: ['product-types'], queryFn: () => api.request<{ data: TypeOption[] }>('GET', '/admin/product-types') });
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api.request<{ data: CategoryOption[] }>('GET', '/admin/categories') });
  const techniques = useQuery({ queryKey: ['techniques'], queryFn: () => api.request<{ data: { id: number; name: string }[] }>('GET', '/admin/techniques') });

  if (!valid || product.isError) {
    return <><PageHeader title="Product" /><FormAlert>{product.error instanceof Error ? product.error.message : 'Product not found'}. <Link to="/products" className="underline">Back to products</Link></FormAlert></>;
  }
  if (!product.data || !types.data || !categories.data || !techniques.data) return <p className="text-ink-700" role="status">Loading the product…</p>;
  const p = product.data;
  const toggle = async (on: boolean) => {
    await api.request('POST', `/admin/products/${p.id}/${on ? 'publish' : 'unpublish'}`, { body: {} });
    toast.success(on ? `“${p.name}” is live` : `“${p.name}” is now a draft`);
    await qc.invalidateQueries({ queryKey: ['product', p.id] });
    await qc.invalidateQueries({ queryKey: ['products'] });
  };

  return (
    <>
      <PageHeader title={p.name}>
        <div className="flex items-center gap-3">
          <StatusPill status={p.status} />
          <PublishToggle row={p} canPublish={canPublish} onToggle={(on) => toggle(on).catch((e: unknown) => { if (e instanceof ApiError && e.code === 'NOT_PUBLISHABLE') throw e; toast.error(errorMessage(e)); })} />
          <Link to="/products" className="text-sm font-medium text-brand-700 underline">All products</Link>
        </div>
      </PageHeader>
      <nav aria-label="Editor sections" className="mb-4 flex flex-wrap gap-1">
        {SECTIONS.map(([sid, label]) => <a key={sid} href={`#${sid}`} className="inline-flex h-9 items-center rounded-md px-3 text-sm text-ink-900 hover:bg-surface-100">{label}</a>)}
      </nav>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          <ContentForm product={p} types={types.data.data} categories={categories.data.data} techniques={techniques.data.data} canWrite={canWrite} />
          <Section id="media" title="Media" note="Saved as you change it"><MediaSection product={p} canEdit={canMedia} /></Section>
          <Section id="variants" title="Variants" note={canPrice ? undefined : 'Prices are read-only for your role'}><VariantsGrid product={p} canWrite={canWrite} canPrice={canPrice} /></Section>
          <Section id="tax" title="Tax"><TaxSection product={p} canApprove={canPublish} /></Section>
        </div>
        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start"><ReadinessPanel product={p} /></aside>
      </div>
    </>
  );
}
