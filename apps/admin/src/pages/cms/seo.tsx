// SEO in the admin (task 6.4) [content:write]: redirects for old addresses (e.g. the previous shop's URLs) and search
// listings (title, description, canonical, hide from search) for any address. Forms on the shared schemas; the
// server's field refusals (an address already used, a target that already redirects) land on their field.
import {
  redirectBody, seoOverrideBody, SEO_DESCRIPTION_MAX, SEO_TITLE_MAX,
  type RedirectInput, type RedirectRow, type SeoOverrideInput, type SeoOverrideRow,
} from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import type { Page } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { DataTable, useTableParams } from '../../components/DataTable';
import { ConfirmDialog, FormDialog } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { applyServerErrors, FormAlert, SelectField, TextField } from '../../components/form';
import { outline, primary, quiet, small, text } from './parts';

function SearchBar({ id, label, params }: { id: string; label: string; params: ReturnType<typeof useTableParams> }) {
  const [value, setValue] = useState(params.filters.q ?? '');
  return (
    <form role="search" className="flex flex-wrap items-end gap-3 text-sm" onSubmit={(e) => { e.preventDefault(); params.setFilter('q', value.trim() || null); }}>
      <div><label htmlFor={id}>{label}</label><input id={id} type="search" maxLength={100} className="mt-1 block h-11 w-64 rounded-md border border-border-input bg-white px-3" value={value} onChange={(e) => setValue(e.target.value)} /></div>
      <button type="submit" className={outline}>Search</button>
    </form>
  );
}

function useSave<F extends Record<string, unknown>>(path: string, fields: readonly string[], setError: Parameters<typeof applyServerErrors<F>>[1], done: () => void) {
  const { api } = useAuth();
  const [problem, setProblem] = useState<string | null>(null);
  const save = async (id: number | null, body: unknown) => {
    setProblem(null);
    try { await api.request(id === null ? 'POST' : 'PUT', id === null ? path : `${path}/${id}`, { body }); toast.success('Saved'); done(); }
    catch (e) { if (!applyServerErrors(e, setError, fields as never)) setProblem(errorMessage(e)); }
  };
  return { save, problem };
}

function useRemove(path: string, refetch: () => void) {
  const { api } = useAuth();
  return async (id: number) => {
    try { await api.request('DELETE', `${path}/${id}`); toast.success('Deleted'); } catch (e) { toast.error(errorMessage(e)); }
    refetch();
  };
}

// ── Redirects ──
export function RedirectsTab() {
  const { api } = useAuth();
  const params = useTableParams({ sort: 'path', filterKeys: ['q'] });
  const query = useQuery({ queryKey: ['seo-redirects', params.page, params.filters], queryFn: () => api.request<Page<RedirectRow>>('GET', '/admin/seo/redirects', { query: { page: params.page, ...params.filters } }), placeholderData: (p) => p });
  const [editing, setEditing] = useState<RedirectRow | 'new' | null>(null);
  const [removing, setRemoving] = useState<RedirectRow | null>(null);
  const remove = useRemove('/admin/seo/redirects', () => void query.refetch());
  const columns: ColumnDef<RedirectRow, unknown>[] = [
    { id: 'from', header: 'Old address', cell: ({ row: { original: r } }) => <code className="text-sm text-ink-900">{r.fromPath}</code> },
    { id: 'to', header: 'Goes to', cell: ({ row: { original: r } }) => <code className="text-sm">{r.toPath}</code> },
    { id: 'kind', header: 'Kind', cell: ({ row: { original: r } }) => <span className="text-sm">{r.statusCode === 301 ? 'Permanent (301)' : 'Temporary (302)'}</span> },
    { id: 'actions', header: 'Actions', cell: ({ row: { original: r } }) => (
      <div className="flex gap-2">
        <button type="button" className={`${small} border border-border-input`} aria-label={`Edit redirect ${r.fromPath}`} onClick={() => setEditing(r)}>Edit</button>
        <button type="button" className={`${small} text-danger-700 hover:bg-[#fee2e2]`} aria-label={`Delete redirect ${r.fromPath}`} onClick={() => setRemoving(r)}>Delete</button>
      </div>) },
  ];
  return (
    <section aria-labelledby="redir-h" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 id="redir-h" className="text-lg font-semibold text-ink-900">Redirects</h2>
          <p className="max-w-[65ch] text-sm text-ink-700">Send visitors and search engines from an old address (for example a link from the previous website) to a page here. Renamed products, types and categories redirect by themselves.</p></div>
        <button type="button" className={primary} onClick={() => setEditing('new')}>Add redirect</button>
      </div>
      <SearchBar id="redir-q" label="Search addresses" params={params} />
      <DataTable caption="Redirects" columns={columns} query={query} params={params} getRowId={(r) => String(r.id)} emptyMessage={params.hasFilters ? 'No redirect matches.' : 'No redirects yet.'} />
      {editing !== null && <RedirectEditor row={editing === 'new' ? null : editing} close={() => setEditing(null)} done={() => { setEditing(null); void query.refetch(); }} />}
      <ConfirmDialog open={removing !== null} onOpenChange={(o) => { if (!o) setRemoving(null); }} title="Delete this redirect?" description={removing ? `${removing.fromPath} will show “page not found” again.` : ''}
        confirmLabel="Delete" danger onConfirm={() => { if (removing) void remove(removing.id); setRemoving(null); }} />
    </section>
  );
}

function RedirectEditor({ row, close, done }: { row: RedirectRow | null; close: () => void; done: () => void }) {
  const form = useForm<RedirectInput, unknown, z.output<typeof redirectBody>>({ resolver: zodResolver(redirectBody), defaultValues: { fromPath: text(row?.fromPath), toPath: text(row?.toPath), statusCode: row?.statusCode ?? 301 } });
  const { save, problem } = useSave<RedirectInput>('/admin/seo/redirects', ['fromPath', 'toPath', 'statusCode'], form.setError, done);
  const e = form.formState.errors;
  return (
    <FormDialog open onOpenChange={(o) => { if (!o) close(); }} title={row ? 'Edit redirect' : 'Add redirect'}>
      <form noValidate onSubmit={form.handleSubmit((b) => save(row?.id ?? null, b))} className="space-y-3">
        <TextField id="rd-from" label="Old address" placeholder="/collections/resin" hint="The part after the domain." {...form.register('fromPath')} error={e.fromPath?.message} />
        <TextField id="rd-to" label="Goes to" placeholder="/type/resins" {...form.register('toPath')} error={e.toPath?.message} />
        <SelectField id="rd-code" label="Kind" {...form.register('statusCode', { setValueAs: Number })} error={e.statusCode?.message}>
          <option value={301}>Permanent (301): the old address is gone for good</option>
          <option value={302}>Temporary (302): it will come back</option>
        </SelectField>
        {problem && <FormAlert>{problem}</FormAlert>}
        <div className="flex justify-end gap-3"><button type="button" className={quiet} onClick={close}>Cancel</button><button type="submit" className={primary} disabled={form.formState.isSubmitting}>Save redirect</button></div>
      </form>
    </FormDialog>
  );
}

// ── Search listings (overrides) ──
export function SearchListingsTab() {
  const { api } = useAuth();
  const params = useTableParams({ sort: 'path', filterKeys: ['q'] });
  const query = useQuery({ queryKey: ['seo-overrides', params.page, params.filters], queryFn: () => api.request<Page<SeoOverrideRow>>('GET', '/admin/seo/overrides', { query: { page: params.page, ...params.filters } }), placeholderData: (p) => p });
  const [editing, setEditing] = useState<SeoOverrideRow | 'new' | null>(null);
  const [removing, setRemoving] = useState<SeoOverrideRow | null>(null);
  const remove = useRemove('/admin/seo/overrides', () => void query.refetch());
  const columns: ColumnDef<SeoOverrideRow, unknown>[] = [
    { id: 'path', header: 'Address', cell: ({ row: { original: r } }) => <code className="text-sm text-ink-900">{r.path}</code> },
    { id: 'listing', header: 'In search results', cell: ({ row: { original: r } }) => (
      <div className="max-w-[48ch] text-sm">
        {r.noindex && <span className="mb-1 inline-block rounded bg-[#fef3c7] px-2 py-0.5 text-xs font-medium text-ink-900">Hidden from search</span>}
        {r.metaTitle && <div className="font-medium text-ink-900">{r.metaTitle}</div>}
        {r.metaDescription && <div className="text-ink-700">{r.metaDescription}</div>}
        {r.canonical && <div className="text-ink-700">Canonical: <code>{r.canonical}</code></div>}
      </div>) },
    { id: 'actions', header: 'Actions', cell: ({ row: { original: r } }) => (
      <div className="flex gap-2">
        <button type="button" className={`${small} border border-border-input`} aria-label={`Edit search listing ${r.path}`} onClick={() => setEditing(r)}>Edit</button>
        <button type="button" className={`${small} text-danger-700 hover:bg-[#fee2e2]`} aria-label={`Delete search listing ${r.path}`} onClick={() => setRemoving(r)}>Delete</button>
      </div>) },
  ];
  return (
    <section aria-labelledby="seo-h" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 id="seo-h" className="text-lg font-semibold text-ink-900">Search listings</h2>
          <p className="max-w-[65ch] text-sm text-ink-700">Change how any page appears in Google: its title and description, the address search engines should treat as the original, or keep it out of search. Products, categories and pages also have their own SEO fields; what you set here wins.</p></div>
        <button type="button" className={primary} onClick={() => setEditing('new')}>Add search listing</button>
      </div>
      <SearchBar id="seo-q" label="Search addresses" params={params} />
      <DataTable caption="Search listings" columns={columns} query={query} params={params} getRowId={(r) => String(r.id)} emptyMessage={params.hasFilters ? 'No listing matches.' : 'No search listings yet.'} />
      {editing !== null && <OverrideEditor row={editing === 'new' ? null : editing} close={() => setEditing(null)} done={() => { setEditing(null); void query.refetch(); }} />}
      <ConfirmDialog open={removing !== null} onOpenChange={(o) => { if (!o) setRemoving(null); }} title="Delete this search listing?" description={removing ? `${removing.path} goes back to its own title and description.` : ''}
        confirmLabel="Delete" danger onConfirm={() => { if (removing) void remove(removing.id); setRemoving(null); }} />
    </section>
  );
}

function OverrideEditor({ row, close, done }: { row: SeoOverrideRow | null; close: () => void; done: () => void }) {
  const form = useForm<SeoOverrideInput, unknown, z.output<typeof seoOverrideBody>>({ resolver: zodResolver(seoOverrideBody), defaultValues: {
    path: text(row?.path), metaTitle: text(row?.metaTitle), metaDescription: text(row?.metaDescription), canonical: text(row?.canonical), noindex: row?.noindex ?? false,
  } });
  const { save, problem } = useSave<SeoOverrideInput>('/admin/seo/overrides', ['path', 'metaTitle', 'metaDescription', 'canonical', 'noindex'], form.setError, done);
  const e = form.formState.errors;
  const title = useWatch({ control: form.control, name: 'metaTitle' }) ?? '';
  const description = useWatch({ control: form.control, name: 'metaDescription' }) ?? '';
  const dErr = e.metaDescription?.message;
  return (
    <FormDialog open onOpenChange={(o) => { if (!o) close(); }} title={row ? 'Edit search listing' : 'Add search listing'}>
      <form noValidate onSubmit={form.handleSubmit((b) => save(row?.id ?? null, b))} className="space-y-3">
        <TextField id="so-path" label="Address" placeholder="/new-arrivals" {...form.register('path')} error={e.path?.message} />
        <TextField id="so-title" label="Title (optional)" hint={`${title.length} / ${SEO_TITLE_MAX}. Google shows about 60 characters.`} {...form.register('metaTitle')} error={e.metaTitle?.message} />
        <div>
          <label htmlFor="so-desc" className="block text-sm font-medium text-ink-900">Description (optional)</label>
          <textarea id="so-desc" rows={3} className="mt-1 block w-full rounded-md border border-border-input p-2 text-sm" aria-invalid={dErr ? true : undefined} aria-describedby={dErr ? 'so-desc-error so-desc-hint' : 'so-desc-hint'} {...form.register('metaDescription')} />
          <p id="so-desc-hint" className="mt-1 text-xs text-ink-700">{description.length} / {SEO_DESCRIPTION_MAX}. Google shows about 155 characters.</p>
          {dErr && <p id="so-desc-error" className="mt-1 text-sm text-danger-700">{dErr}</p>}
        </div>
        <TextField id="so-canon" label="Canonical address (optional)" placeholder="/shop or https://artq.in/shop" {...form.register('canonical')} error={e.canonical?.message} />
        <label className="flex items-center gap-3 text-sm"><input type="checkbox" className="h-5 w-5 accent-brand-700" {...form.register('noindex')} />Hide this page from search engines</label>
        {problem && <FormAlert>{problem}</FormAlert>}
        <div className="flex justify-end gap-3"><button type="button" className={quiet} onClick={close}>Cancel</button><button type="submit" className={primary} disabled={form.formState.isSubmitting}>Save listing</button></div>
      </form>
    </FormDialog>
  );
}
