// Product Types, Categories and Techniques (product.md §7.2 modules, api.md §4.4, task 2.6). One page for the three:
// list in display order with usage counts, move up/down, add/edit in a dialog (validated with the API's schemas), and
// delete with confirmation, which the API refuses while the record is in use, explaining what to do instead.
import {
  createCategoryBody, createProductTypeBody, createTechniqueBody, updateCategoryBody, updateProductTypeBody, updateTechniqueBody,
} from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ImageOff, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { ApiError } from '../../api/client';
import { imageProblem, uploadImage } from '../../api/upload';
import { useAuth } from '../../auth/AuthProvider';
import { btn, ConfirmDialog, FormDialog } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { applyServerErrors, FormAlert, SelectField, TextField } from '../../components/form';
import { PageHeader } from '../simple';

export type Kind = 'type' | 'category' | 'technique';
type Thumb = { status: string; url: string | null } | null;
type ListRow = { id: number; name: string; slug: string; isActive: boolean; sortOrder: number; image: Thumb; typeId?: number; productCount?: number; categoryCount?: number; showOnHome?: boolean; showInMenu?: boolean };
type Detail = Record<string, unknown> & { id: number; name: string; slug: string; media: Record<string, { renditions?: Record<string, string>; status?: string } | null> };

const CONFIG = {
  type: { title: 'Product Types', one: 'product type', path: '/admin/product-types', create: createProductTypeBody, update: updateProductTypeBody, images: [['imageMediaId', 'Tile image'], ['bannerMediaId', 'Banner image']] as const },
  category: { title: 'Categories', one: 'category', path: '/admin/categories', create: createCategoryBody, update: updateCategoryBody, images: [['imageMediaId', 'Image']] as const },
  technique: { title: 'Techniques', one: 'technique', path: '/admin/techniques', create: createTechniqueBody, update: updateTechniqueBody, images: [['imageMediaId', 'Image'], ['heroMediaId', 'Hero image']] as const },
} as const;

const blankToNull = z.string().transform((s) => (s.trim() === '' ? null : s));
/** Form shape → API shape, then the API's own create / update schema (CLAUDE.md "Validation rule"). */
function formSchema(kind: Kind, mode: 'create' | 'update') {
  const base = {
    name: z.string(), slug: z.string().transform((s) => (s.trim() === '' ? undefined : s)), description: blankToNull,
    isActive: z.boolean(), metaTitle: blankToNull, metaDescription: blankToNull,
    imageMediaId: z.number().nullable(), bannerMediaId: z.number().nullable(), heroMediaId: z.number().nullable(),
    tileLinkUrl: blankToNull, showOnHome: z.boolean(), showInMenu: z.boolean(),
    typeId: z.number().nullable(), defaultHsnCode: blankToNull, defaultGstRate: z.union([z.number(), z.null()]),
  };
  const pick: Record<Kind, (keyof typeof base)[]> = {
    type: ['name', 'slug', 'description', 'isActive', 'metaTitle', 'metaDescription', 'imageMediaId', 'bannerMediaId', 'tileLinkUrl', 'showOnHome', 'showInMenu'],
    category: ['name', 'slug', 'description', 'isActive', 'metaTitle', 'metaDescription', 'imageMediaId', 'typeId', 'defaultHsnCode', 'defaultGstRate'],
    technique: ['name', 'slug', 'description', 'isActive', 'metaTitle', 'metaDescription', 'imageMediaId', 'heroMediaId'],
  };
  const shape = Object.fromEntries(pick[kind].map((k) => [k, base[k]]));
  // z.any() bridges into the API schema (it checks at run time and defines the output type).
  return z.object(shape).transform((v) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined))).pipe(z.any()).pipe(CONFIG[kind][mode]);
}
type FormValues = Record<string, string | number | boolean | null>;

function defaults(kind: Kind, d: Detail | null, typeId: number | null): FormValues {
  const s = (k: string) => (d && typeof d[k] === 'string' ? (d[k] as string) : '');
  const n = (k: string) => (d && typeof d[k] === 'number' ? (d[k] as number) : null);
  const common = { name: s('name'), slug: s('slug'), description: s('description'), isActive: d ? Boolean(d.isActive) : true, metaTitle: s('metaTitle'), metaDescription: s('metaDescription'), imageMediaId: n('imageMediaId') };
  if (kind === 'type') return { ...common, bannerMediaId: n('bannerMediaId'), tileLinkUrl: s('tileLinkUrl'), showOnHome: d ? Boolean(d.showOnHome) : true, showInMenu: d ? Boolean(d.showInMenu) : true };
  if (kind === 'category') return { ...common, typeId: n('typeId') ?? typeId, defaultHsnCode: s('defaultHsnCode'), defaultGstRate: n('defaultGstRate') };
  return { ...common, heroMediaId: n('heroMediaId') };
}

function ImageField({ id, label, value, preview, onChange, error }: { id: string; label: string; value: number | null; preview: string | null; onChange: (v: number | null) => void; error?: string | undefined }) {
  const { api } = useAuth();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [local, setLocal] = useState<string | null>(null);
  const shown = value === null ? null : (local ?? preview);
  const pick = async (file: File) => {
    const p = imageProblem(file);
    setProblem(p);
    if (p) return;
    setBusy(true);
    try { onChange(await uploadImage(api, file)); setLocal(URL.createObjectURL(file)); } catch (e) { setProblem(errorMessage(e)); } finally { setBusy(false); }
  };
  const message = problem ?? error;
  return (
    <div>
      <span className="block text-sm font-medium text-ink-900" id={`${id}-label`}>{label}</span>
      <div className="mt-1 flex items-center gap-3">
        <span className={`flex h-16 w-16 items-center justify-center overflow-hidden rounded border ${message ? 'border-danger-700' : 'border-surface-200'} bg-surface-50`}>
          {busy ? <Loader2 aria-hidden size={18} className="animate-spin motion-reduce:animate-none" /> : shown ? <img src={shown} alt="" className="h-16 w-16 object-cover" /> : value !== null ? <span className="px-1 text-center text-xs text-ink-700">Processing</span> : <ImageOff aria-hidden size={18} className="text-ink-700" />}
        </span>
        <label className="inline-flex h-11 cursor-pointer items-center rounded-md border border-border-input px-4 text-sm font-medium text-ink-900 hover:bg-surface-100 focus-within:outline-2 focus-within:outline-brand-700">
          {value === null ? 'Upload' : 'Replace'}
          <input id={id} type="file" accept="image/jpeg,image/png,image/webp,image/avif" className="sr-only" aria-labelledby={`${id}-label`} aria-describedby={message ? `${id}-error` : undefined}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f); e.target.value = ''; }} />
        </label>
        {value !== null && <button type="button" className="h-11 rounded-md px-3 text-sm font-medium text-danger-700 hover:bg-surface-100" onClick={() => { onChange(null); setLocal(null); }}>Remove</button>}
      </div>
      {message && <p id={`${id}-error`} className="mt-1 text-sm text-danger-700">{message}</p>}
    </div>
  );
}

function EditDialog({ kind, detail, types, defaultTypeId, onClose }: { kind: Kind; detail: Detail | null; types: { id: number; name: string }[]; defaultTypeId: number | null; onClose: () => void }) {
  const { api } = useAuth();
  const qc = useQueryClient();
  const cfg = CONFIG[kind];
  const mode = detail ? 'update' : 'create';
  const [error, setError] = useState<string | null>(null);
  const { register, control, handleSubmit, setError: setFieldError, formState: { errors, isSubmitting } } = useForm<FormValues, unknown, Record<string, unknown>>({
    resolver: zodResolver(formSchema(kind, mode) as unknown as z.ZodType<Record<string, unknown>, FormValues>), defaultValues: defaults(kind, detail, defaultTypeId),
  });
  const msg = (k: string) => (errors[k]?.message as string | undefined);
  const submit = async (values: Record<string, unknown>) => {
    setError(null);
    try {
      if (detail) await api.request('PATCH', `${cfg.path}/${detail.id}`, { body: values });
      else await api.request('POST', cfg.path, { body: values });
      toast.success(detail ? `“${values.name as string}” saved` : `“${values.name as string}” added`);
      await qc.invalidateQueries({ queryKey: ['taxonomy'] });
      await qc.invalidateQueries({ queryKey: ['product-types'] });
      await qc.invalidateQueries({ queryKey: ['categories'] });
      await qc.invalidateQueries({ queryKey: ['techniques'] });
      onClose();
    } catch (e) {
      if (!applyServerErrors(e, setFieldError, Object.keys(defaults(kind, null, null)))) setError(errorMessage(e));
    }
  };
  const preview = (k: string) => {
    const id = detail?.[k];
    const m = typeof id === 'number' ? detail?.media[id] : null;
    return m?.renditions ? (m.renditions['160'] ?? Object.values(m.renditions)[0] ?? null) : null;
  };
  const toNum = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v));
  return (
    <FormDialog open onOpenChange={(o) => { if (!o) onClose(); }} title={detail ? `Edit “${detail.name}”` : `Add ${cfg.one}`}>
      <form noValidate className="max-h-[70vh] space-y-4 overflow-y-auto pr-1" onSubmit={(e) => { void handleSubmit(submit)(e); }}>
        <TextField id="tx-name" label="Name" {...register('name')} error={msg('name')} />
        {kind === 'category' && (
          <SelectField id="tx-type" label="Product type" {...register('typeId', { setValueAs: toNum })} error={msg('typeId')}>
            <option value="">Choose…</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </SelectField>
        )}
        <TextField id="tx-slug" label="URL slug" {...register('slug')} error={msg('slug')} hint={detail ? 'Changing it keeps the old address working (redirect).' : 'Leave empty to make one from the name.'} />
        <div>
          <label htmlFor="tx-description" className="block text-sm font-medium text-ink-900">Description</label>
          <textarea id="tx-description" rows={3} {...register('description')} aria-invalid={msg('description') ? true : undefined} aria-describedby={msg('description') ? 'tx-description-error' : undefined}
            className="mt-1 block w-full rounded-md border border-border-input bg-white px-3 py-2 text-ink-900" />
          {msg('description') && <p id="tx-description-error" className="mt-1 text-sm text-danger-700">{msg('description')}</p>}
        </div>
        {cfg.images.map(([field, label]) => (
          <Controller key={field} control={control} name={field} render={({ field: f }) => (
            <ImageField id={`tx-${field}`} label={label} value={(f.value as number | null) ?? null} preview={preview(field)} onChange={f.onChange} error={msg(field)} />
          )} />
        ))}
        {kind === 'type' && <>
          <TextField id="tx-tile" label="Tile link (optional)" {...register('tileLinkUrl')} error={msg('tileLinkUrl')} hint="Where the home-page tile goes, e.g. /types/epoxy-resin. Leave empty for the type's own page." />
          <label className="flex items-center gap-2 text-sm text-ink-900"><input type="checkbox" className="h-4 w-4 accent-brand-700" {...register('showOnHome')} /> Show on the home page</label>
          <label className="flex items-center gap-2 text-sm text-ink-900"><input type="checkbox" className="h-4 w-4 accent-brand-700" {...register('showInMenu')} /> Show in the shop menu</label>
        </>}
        {kind === 'category' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField id="tx-hsn" label="Default HSN code (optional)" inputMode="numeric" {...register('defaultHsnCode')} error={msg('defaultHsnCode')} />
            <TextField id="tx-gst" label="Default GST rate % (optional)" inputMode="decimal" {...register('defaultGstRate', { setValueAs: toNum })} error={msg('defaultGstRate')} />
          </div>
        )}
        <label className="flex items-center gap-2 text-sm text-ink-900"><input type="checkbox" className="h-4 w-4 accent-brand-700" {...register('isActive')} /> Active (shown on the storefront)</label>
        <TextField id="tx-meta-title" label="SEO title (optional)" {...register('metaTitle')} error={msg('metaTitle')} />
        <TextField id="tx-meta-description" label="SEO description (optional)" {...register('metaDescription')} error={msg('metaDescription')} />
        {error && <FormAlert>{error}</FormAlert>}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" className={`${btn} text-ink-900 hover:bg-surface-100`} onClick={onClose}>Cancel</button>
          <button type="submit" disabled={isSubmitting} aria-busy={isSubmitting || undefined} className={`${btn} bg-brand-700 text-white disabled:opacity-80`}>{isSubmitting ? 'Saving…' : detail ? 'Save' : `Add ${cfg.one}`}</button>
        </div>
      </form>
    </FormDialog>
  );
}

export function TaxonomyPage({ kind }: { kind: Kind }) {
  const { api, state } = useAuth();
  const qc = useQueryClient();
  const cfg = CONFIG[kind];
  const canWrite = state.status === 'authenticated' && state.permissions.includes('catalog:write');
  const [typeFilter, setTypeFilter] = useState<number | null>(null);
  const [editing, setEditing] = useState<Detail | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ListRow | null>(null);
  const [refused, setRefused] = useState<{ row: ListRow; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const types = useQuery({ queryKey: ['product-types'], queryFn: () => api.request<{ data: { id: number; name: string }[] }>('GET', '/admin/product-types'), enabled: kind === 'category' });
  const list = useQuery({
    queryKey: ['taxonomy', kind, typeFilter],
    queryFn: () => api.request<{ data: ListRow[] }>('GET', cfg.path, { query: { withCounts: 1, ...(kind === 'category' && typeFilter ? { typeId: typeFilter } : {}) } }),
  });
  const rows = list.data?.data ?? [];
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['taxonomy'] }); await qc.invalidateQueries({ queryKey: ['product-types'] }); };
  const openEdit = async (row: ListRow) => {
    try { setEditing(await api.request<Detail>('GET', `${cfg.path}/${row.id}`)); } catch (e) { toast.error(errorMessage(e)); }
  };
  const move = async (i: number, d: -1 | 1) => {
    const ids = rows.map((r) => r.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    try { await api.request('PATCH', `${cfg.path}/reorder`, { body: { ids } }); await refresh(); } catch (e) { toast.error(errorMessage(e)); }
  };
  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.request('DELETE', `${cfg.path}/${deleting.id}`);
      toast.success(`“${deleting.name}” deleted`);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TAXONOMY_IN_USE') setRefused({ row: deleting, message: e.message });
      else toast.error(errorMessage(e));
    } finally { setBusy(false); setDeleting(null); }
  };
  const typeName = (id: number | undefined) => types.data?.data.find((t) => t.id === id)?.name ?? '';
  // Reordering categories only makes sense within one type.
  const canReorder = canWrite && (kind !== 'category' || typeFilter !== null);

  return (
    <>
      <PageHeader title={cfg.title}>
        {canWrite && <button type="button" className={`${btn} bg-brand-700 text-white`} onClick={() => setEditing('new')}>Add {cfg.one}</button>}
      </PageHeader>
      {kind === 'category' && (
        <label className="mb-4 block text-sm text-ink-900">Product type
          <select className="mt-1 block h-11 w-64 rounded-md border border-border-input bg-white px-3" value={typeFilter ?? ''} onChange={(e) => setTypeFilter(e.target.value ? Number(e.target.value) : null)}>
            <option value="">All types</option>{(types.data?.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      )}
      {list.isError && <FormAlert>Couldn&apos;t load. {errorMessage(list.error)}</FormAlert>}
      <div className="overflow-x-auto rounded-lg border border-surface-200 bg-white">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">{cfg.title}</caption>
          <thead className="bg-surface-100 text-ink-700">
            <tr>
              <th scope="col" className="w-24 px-4 py-3 font-semibold">Order</th>
              <th scope="col" className="w-16 px-4 py-3 font-semibold">Image</th>
              <th scope="col" className="px-4 py-3 font-semibold">Name</th>
              {kind === 'category' && <th scope="col" className="px-4 py-3 font-semibold">Type</th>}
              <th scope="col" className="px-4 py-3 font-semibold">Used by</th>
              <th scope="col" className="px-4 py-3 font-semibold">Status</th>
              <th scope="col" className="px-4 py-3"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {list.isPending && <tr><td colSpan={7} className="px-4 py-8 text-center text-ink-700">Loading…</td></tr>}
            {!list.isPending && rows.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-ink-700">No {cfg.title.toLowerCase()} yet.</td></tr>}
            {rows.map((r, i) => (
              <tr key={r.id} className="border-t border-surface-200">
                <td className="px-4 py-2">
                  <div className="flex items-center gap-1">
                    <span className="w-6 tabular-nums text-ink-700">{i + 1}</span>
                    {canReorder && <>
                      <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded hover:bg-surface-100 disabled:opacity-40" disabled={i === 0} onClick={() => void move(i, -1)} aria-label={`Move ${r.name} up`}><ArrowUp aria-hidden size={16} /></button>
                      <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded hover:bg-surface-100 disabled:opacity-40" disabled={i === rows.length - 1} onClick={() => void move(i, 1)} aria-label={`Move ${r.name} down`}><ArrowDown aria-hidden size={16} /></button>
                    </>}
                  </div>
                </td>
                <td className="px-4 py-2">
                  <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded border border-surface-200 bg-surface-50">
                    {r.image?.url ? <img src={r.image.url} alt="" className="h-10 w-10 object-cover" /> : <ImageOff aria-hidden size={16} className="text-ink-700" />}
                  </span>
                </td>
                <td className="px-4 py-2"><p className="font-medium text-ink-900">{r.name}</p><p className="text-xs text-ink-700">/{r.slug}</p></td>
                {kind === 'category' && <td className="px-4 py-2 text-ink-900">{typeName(r.typeId)}</td>}
                <td className="px-4 py-2 tabular-nums text-ink-900">
                  {kind === 'type' ? <Link to={`/products?type=${r.id}`} className="text-brand-700 underline">{r.productCount ?? 0} products</Link> : `${r.productCount ?? 0} products`}
                  {kind === 'type' && <span className="text-ink-700"> · {r.categoryCount ?? 0} categories</span>}
                </td>
                <td className="px-4 py-2">
                  <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${r.isActive ? 'bg-[#dcfce7] text-success-700' : 'bg-surface-200 text-ink-700'}`}>{r.isActive ? 'Active' : 'Off'}</span>
                  {kind === 'type' && <span className="ml-2 text-xs text-ink-700">{[r.showOnHome ? 'Home' : null, r.showInMenu ? 'Menu' : null].filter(Boolean).join(' · ') || 'Hidden from home and menu'}</span>}
                </td>
                <td className="px-4 py-2">
                  {canWrite && (
                    <div className="flex justify-end gap-1">
                      <button type="button" className="h-11 rounded-md px-3 font-medium text-brand-700 hover:bg-surface-100" onClick={() => void openEdit(r)} aria-label={`Edit ${r.name}`}>Edit</button>
                      <button type="button" className="h-11 rounded-md px-3 font-medium text-danger-700 hover:bg-surface-100" onClick={() => setDeleting(r)} aria-label={`Delete ${r.name}`}>Delete</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {kind === 'category' && canWrite && typeFilter === null && rows.length > 1 && <p className="mt-2 text-sm text-ink-700">Choose a product type to change the order of its categories.</p>}
      {editing && <EditDialog kind={kind} detail={editing === 'new' ? null : editing} types={types.data?.data ?? []} defaultTypeId={typeFilter} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog open onOpenChange={(o) => { if (!o) setDeleting(null); }} title={`Delete “${deleting.name}”?`} danger busy={busy} confirmLabel="Delete" onConfirm={() => void remove()}
          description={`This removes the ${cfg.one} permanently. You can only delete it when nothing uses it; otherwise turn it off instead.`} />
      )}
      {refused && (
        <FormDialog open onOpenChange={(o) => { if (!o) setRefused(null); }} title={`“${refused.row.name}” is still in use`} description={refused.message}>
          <div className="flex flex-wrap justify-end gap-3">
            {kind === 'type' && <Link to={`/products?type=${refused.row.id}`} className={`${btn} border border-border-input text-ink-900 hover:bg-surface-100`}>See its products</Link>}
            <button type="button" className={`${btn} bg-brand-700 text-white`} onClick={() => setRefused(null)}>OK</button>
          </div>
        </FormDialog>
      )}
    </>
  );
}
