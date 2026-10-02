// Products page (product.md §7.3, api.md §4.3): type tabs with counts, search and filters in the URL, the table with
// thumbnail states, price range, stock, status + activation toggle + readiness, row actions, bulk actions, variant drawer.
import { READINESS, type ProductListRow } from '@artq/shared';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { ChevronDown, MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ApiError, type Page } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { DataTable, useTableParams } from '../../components/DataTable';
import { btn, ConfirmDialog, FormDialog } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { PageHeader } from '../simple';
import { AddProductDialog, type CategoryOption } from './AddProductDialog';
import { PriceRange, PublishToggle, ReadinessBadge, StatusPill, Stock, Thumb, TypeBadge } from './parts';
import { VariantDrawer } from './VariantDrawer';

type TypeTab = { id: number; name: string; productCount: number };
type TypeCounts = { data: TypeTab[]; unassigned: number; total: number };
type BulkResult = { id: number; ok: boolean; error?: { code: string; message: string; details?: { failures?: { check: string; fix: string }[] } } };

const VISIBLE_TABS = 5;
const FILTERS = ['q', 'type', 'status', 'stock', 'readiness', 'imageState'];
const select = 'mt-1 block h-11 rounded-md border border-border-input bg-white px-3 text-ink-900';
const tabClass = (on: boolean) => `inline-flex h-11 items-center gap-2 rounded-md px-3 text-sm font-medium ${on ? 'bg-brand-700 text-white' : 'text-ink-900 hover:bg-surface-100'}`;
const count = (n: number, on: boolean) => <span className={`rounded-full px-2 text-xs ${on ? 'bg-white/20' : 'bg-surface-100 text-ink-700'}`}>{n}</span>;

function TypeTabs({ counts, current, onPick }: { counts: TypeCounts | undefined; current: string | undefined; onPick: (v: string | null) => void }) {
  const types = counts?.data ?? [];
  const shown = types.slice(0, VISIBLE_TABS);
  const more = types.slice(VISIBLE_TABS);
  const moreActive = more.find((t) => String(t.id) === current);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1 border-b border-surface-200 pb-2" role="group" aria-label="Product types">
      <button type="button" aria-pressed={!current} className={tabClass(!current)} onClick={() => onPick(null)}>All {count(counts?.total ?? 0, !current)}</button>
      {shown.map((t) => {
        const on = current === String(t.id);
        return <button key={t.id} type="button" aria-pressed={on} className={tabClass(on)} onClick={() => onPick(String(t.id))}>{t.name} {count(t.productCount, on)}</button>;
      })}
      {more.length > 0 && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger className={tabClass(!!moreActive)} aria-label={moreActive ? `More types (showing ${moreActive.name})` : 'More types'}>
            {moreActive ? moreActive.name : 'More'} <ChevronDown aria-hidden size={16} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="z-50 min-w-48 rounded-md border border-surface-200 bg-white p-1 shadow-lg" sideOffset={4}>
              {more.map((t) => (
                <DropdownMenu.Item key={t.id} className="flex h-10 cursor-pointer items-center justify-between gap-4 rounded px-3 text-sm text-ink-900 outline-none data-[highlighted]:bg-surface-100" onSelect={() => onPick(String(t.id))}>
                  {t.name} {count(t.productCount, false)}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
      <button type="button" aria-pressed={current === 'unassigned'} className={tabClass(current === 'unassigned')} onClick={() => onPick('unassigned')}>Unassigned {count(counts?.unassigned ?? 0, current === 'unassigned')}</button>
    </div>
  );
}

function BulkResults({ results, rows, onClose }: { results: BulkResult[]; rows: Map<number, string>; onClose: () => void }) {
  const failed = results.filter((r) => !r.ok);
  return (
    <FormDialog open onOpenChange={(o) => { if (!o) onClose(); }} title={`${results.length - failed.length} done, ${failed.length} not changed`}>
      <ul className="max-h-80 space-y-3 overflow-y-auto text-sm">
        {failed.map((r) => (
          <li key={r.id}>
            <p className="font-semibold text-ink-900">{rows.get(r.id) ?? `Product #${r.id}`}</p>
            <p className="text-danger-700">{r.error?.message}</p>
            {r.error?.details?.failures && <ul className="list-disc pl-5 text-ink-700">{r.error.details.failures.map((f) => <li key={f.check}>{f.check}: {f.fix}</li>)}</ul>}
          </li>
        ))}
      </ul>
      <div className="mt-4 flex justify-end"><button type="button" className={`${btn} bg-brand-700 text-white`} onClick={onClose}>Close</button></div>
    </FormDialog>
  );
}

function SetTaxonomyDialog({ kind, types, onApply, onClose }: { kind: 'type' | 'category'; types: TypeTab[]; onApply: (id: number) => void; onClose: () => void }) {
  const { api } = useAuth();
  const [value, setValue] = useState('');
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api.request<{ data: CategoryOption[] }>('GET', '/admin/categories'), enabled: kind === 'category' });
  const options = kind === 'type' ? types.map((t) => ({ id: t.id, name: t.name })) : (cats.data?.data ?? []).map((c) => ({ id: c.id, name: `${c.name} (${types.find((t) => t.id === c.typeId)?.name ?? 'type'})` }));
  return (
    <FormDialog open onOpenChange={(o) => { if (!o) onClose(); }} title={kind === 'type' ? 'Set product type' : 'Set category'}
      description={kind === 'type' ? 'A draft whose category belongs to another type loses its category. Live products keep theirs and are skipped.' : 'The product type follows the category.'}>
      <label htmlFor="bulk-taxonomy" className="block text-sm font-medium text-ink-900">{kind === 'type' ? 'Product type' : 'Category'}</label>
      <select id="bulk-taxonomy" className={`${select} w-full`} value={value} onChange={(e) => setValue(e.target.value)}>
        <option value="">Choose…</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
      <div className="mt-6 flex justify-end gap-3">
        <button type="button" className={`${btn} text-ink-900 hover:bg-surface-100`} onClick={onClose}>Cancel</button>
        <button type="button" disabled={!value} className={`${btn} bg-brand-700 text-white disabled:opacity-60`} onClick={() => onApply(Number(value))}>Apply</button>
      </div>
    </FormDialog>
  );
}

export function ProductsPage() {
  const { api, state } = useAuth();
  const qc = useQueryClient();
  const perms = state.status === 'authenticated' ? state.permissions : [];
  const canWrite = perms.includes('catalog:write');
  const canPublish = perms.includes('catalog:publish');
  const canPrice = perms.includes('pricing:write');
  const params = useTableParams({ sort: 'updated_desc', filterKeys: FILTERS });
  const [adding, setAdding] = useState(false);
  const [drawer, setDrawer] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<{ row: ProductListRow; action: 'delete' | 'archive' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [bulk, setBulk] = useState<{ results: BulkResult[]; names: Map<number, string> } | null>(null);
  const [taxonomy, setTaxonomy] = useState<{ kind: 'type' | 'category'; ids: number[]; clear: () => void } | null>(null);

  const counts = useQuery({ queryKey: ['product-types', 'counts'], queryFn: () => api.request<TypeCounts>('GET', '/admin/product-types', { query: { withCounts: 1 } }) });
  const query = useQuery({
    queryKey: ['products', params.page, params.sort, params.filters],
    queryFn: () => api.request<Page<ProductListRow>>('GET', '/admin/products', { query: { page: params.page, limit: 20, sort: params.sort, ...params.filters } }),
    placeholderData: (prev) => prev,
  });
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['products'] }); await qc.invalidateQueries({ queryKey: ['product-types'] }); };
  const rows = query.data?.data ?? [];

  const toggle = async (row: ProductListRow, on: boolean) => {
    await api.request('POST', `/admin/products/${row.id}/${on ? 'publish' : 'unpublish'}`, { body: {} });
    toast.success(on ? `“${row.name}” is live` : `“${row.name}” is now a draft`);
    await refresh();
  };
  const runConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.action === 'delete') await api.request('DELETE', `/admin/products/${confirm.row.id}`);
      else await api.request('POST', `/admin/products/${confirm.row.id}/archive`, { body: {} });
      toast.success(confirm.action === 'delete' ? `“${confirm.row.name}” deleted` : `“${confirm.row.name}” archived`);
      setConfirm(null);
      await refresh();
    } catch (e) {
      toast.error(e instanceof ApiError && e.code === 'ARCHIVE_INSTEAD' ? `${e.message}.` : errorMessage(e));
      setConfirm(null);
    } finally { setBusy(false); }
  };
  const runBulk = async (body: Record<string, unknown>, ids: string[], clear: () => void, label: string) => {
    try {
      const res = await api.request<{ results: BulkResult[] }>('POST', '/admin/products/bulk', { body: { ...body, ids: ids.map(Number) } });
      const failed = res.results.filter((r) => !r.ok).length;
      if (failed === 0) toast.success(`${label}: ${res.results.length} updated`);
      else setBulk({ results: res.results, names: new Map(rows.map((r) => [r.id, r.name])) });
      clear();
      await refresh();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const columns: ColumnDef<ProductListRow, unknown>[] = [
    { id: 'serial', header: '#', cell: ({ row }) => <span className="tabular-nums text-ink-700">{row.original.serial}</span>, meta: { className: 'w-12' } },
    { id: 'image', header: 'Image', cell: ({ row }) => <Thumb image={row.original.image} name={row.original.name} />, meta: { className: 'w-16 py-2' } },
    { id: 'name', header: 'Name', cell: ({ row }) => (
      <div className="min-w-48">
        <Link to={`/products/${row.original.id}`} className="font-medium text-ink-900 hover:underline">{row.original.name}</Link>
        <p className="text-xs text-ink-700">{row.original.category?.name ?? 'No category'}{row.original.flags.length > 0 && <span className="ml-2 text-warning-700">{row.original.flags.length} flag{row.original.flags.length > 1 ? 's' : ''}: {row.original.flags.join(', ')}</span>}</p>
      </div>
    ) },
    { id: 'type', header: 'Type', cell: ({ row }) => <TypeBadge type={row.original.type} /> },
    { id: 'price', header: 'Price', cell: ({ row }) => <PriceRange range={row.original.priceRange} />, meta: { className: 'whitespace-nowrap' } },
    { id: 'available', header: 'Available', cell: ({ row }) => <Stock row={row.original} /> },
    { id: 'status', header: 'Status', cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <PublishToggle row={row.original} canPublish={canPublish} onToggle={(on) => toggle(row.original, on).catch((e: unknown) => { if (e instanceof ApiError && e.code === 'NOT_PUBLISHABLE') throw e; toast.error(errorMessage(e)); })} />
        <StatusPill status={row.original.status} />
        <ReadinessBadge row={row.original} />
      </div>
    ), meta: { className: 'whitespace-nowrap' } },
    { id: 'variants', header: 'Variants', cell: ({ row }) => <span className="tabular-nums">{row.original.variantCount}</span> },
    { id: 'actions', header: () => <span className="sr-only">Actions</span>, cell: ({ row }) => {
      const r = row.original;
      const canDelete = canWrite && r.deletable;
      const canArchive = canPublish && r.status !== 'ARCHIVED';
      return (
        <div className="flex items-center gap-1">
          <Link to={`/products/${r.id}`} className="inline-flex h-11 items-center rounded-md px-3 font-medium text-brand-700 hover:bg-surface-100">Edit</Link>
          <button type="button" className="inline-flex h-11 items-center rounded-md px-3 font-medium text-ink-900 hover:bg-surface-100" onClick={() => setDrawer(r.id)} aria-label={`Variants of ${r.name}`}>Variants</button>
          {(canDelete || canArchive) && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger className="inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-surface-100" aria-label={`More actions for ${r.name}`}><MoreHorizontal aria-hidden size={18} /></DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="z-50 min-w-40 rounded-md border border-surface-200 bg-white p-1 shadow-lg" align="end" sideOffset={4}>
                  {/* Delete only for never-ordered drafts; otherwise Archive (product.md §7.3). */}
                  {canDelete
                    ? <DropdownMenu.Item className="flex h-10 cursor-pointer items-center rounded px-3 text-sm text-danger-700 outline-none data-[highlighted]:bg-surface-100" onSelect={() => setConfirm({ row: r, action: 'delete' })}>Delete</DropdownMenu.Item>
                    : <DropdownMenu.Item className="flex h-10 cursor-pointer items-center rounded px-3 text-sm text-ink-900 outline-none data-[highlighted]:bg-surface-100" onSelect={() => setConfirm({ row: r, action: 'archive' })}>Archive</DropdownMenu.Item>}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </div>
      );
    } },
  ];

  const bulkButton = 'h-9 rounded-md border border-border-input bg-white px-3 font-medium text-ink-900 hover:bg-surface-100';
  return (
    <>
      <PageHeader title="Products">
        <div className="flex flex-wrap gap-2">
          <Link to="/imports" className={`${btn} border border-border-input text-ink-900 hover:bg-surface-100`}>Import / Export</Link>
          {canWrite && <button type="button" onClick={() => setAdding(true)} className={`${btn} bg-brand-700 text-white`}>Add product</button>}
        </div>
      </PageHeader>
      <TypeTabs counts={counts.data} current={params.filters.type} onPick={(v) => params.setFilter('type', v)} />
      <form className="mb-4 flex flex-wrap items-end gap-3" role="search" onSubmit={(e) => e.preventDefault()}>
        <label className="text-sm text-ink-900">Search name, SKU or slug
          <input className="mt-1 block h-11 w-64 rounded-md border border-border-input px-3" defaultValue={params.filters.q ?? ''} key={params.filters.q ?? ''}
            onBlur={(e) => params.setFilter('q', e.target.value.trim() || null)} onKeyDown={(e) => { if (e.key === 'Enter') params.setFilter('q', (e.target as HTMLInputElement).value.trim() || null); }} />
        </label>
        <label className="text-sm text-ink-900">Status
          <select className={select} value={params.filters.status ?? ''} onChange={(e) => params.setFilter('status', e.target.value || null)}>
            <option value="">Any</option><option value="DRAFT">Draft</option><option value="ACTIVE">Active</option><option value="ARCHIVED">Archived</option>
          </select>
        </label>
        <label className="text-sm text-ink-900">Stock
          <select className={select} value={params.filters.stock ?? ''} onChange={(e) => params.setFilter('stock', e.target.value || null)}>
            <option value="">Any</option><option value="in">In stock</option><option value="low">Low</option><option value="out">Out of stock</option><option value="oversold">Oversold</option>
          </select>
        </label>
        <label className="text-sm text-ink-900">Readiness
          <select className={select} value={params.filters.readiness ?? ''} onChange={(e) => params.setFilter('readiness', e.target.value || null)}>
            <option value="">Any</option><option value="ready">Ready to publish</option><option value="blocked">Not ready</option>
            {Object.entries(READINESS).map(([code, r]) => <option key={code} value={code}>Failing: {r.check}{code === 'variant_flags' ? ' (variants)' : ''}</option>)}
          </select>
        </label>
        <label className="text-sm text-ink-900">Image
          <select className={select} value={params.filters.imageState ?? ''} onChange={(e) => params.setFilter('imageState', e.target.value || null)}>
            <option value="">Any</option><option value="ready">Ready</option><option value="processing">Processing</option><option value="failed">Failed</option><option value="missing">Missing</option>
          </select>
        </label>
        <label className="text-sm text-ink-900">Sort by
          <select className={select} value={params.sort} onChange={(e) => params.setSort(e.target.value)}>
            <option value="updated_desc">Recently updated</option><option value="name">Name</option><option value="price">Price (low first)</option><option value="stock">Stock (low first)</option>
          </select>
        </label>
      </form>
      <DataTable caption="Products" columns={columns} query={query} params={params} getRowId={(r) => String(r.id)} emptyMessage="No products match."
        selectable={canWrite || canPublish}
        bulkActions={(ids, clear) => (
          <>
            {canPublish && <>
              <button type="button" className={bulkButton} onClick={() => void runBulk({ action: 'publish' }, ids, clear, 'Publish')}>Publish</button>
              <button type="button" className={bulkButton} onClick={() => void runBulk({ action: 'unpublish' }, ids, clear, 'Unpublish')}>Unpublish</button>
              <button type="button" className={bulkButton} onClick={() => void runBulk({ action: 'archive' }, ids, clear, 'Archive')}>Archive</button>
            </>}
            {canWrite && <>
              <button type="button" className={bulkButton} onClick={() => void runBulk({ action: 'markNew' }, ids, clear, 'Mark new')}>Mark new</button>
              <button type="button" className={bulkButton} onClick={() => void runBulk({ action: 'unmarkNew' }, ids, clear, 'Unmark new')}>Unmark new</button>
              <button type="button" className={bulkButton} onClick={() => void runBulk({ action: 'markTrending' }, ids, clear, 'Mark trending')}>Mark trending</button>
              <button type="button" className={bulkButton} onClick={() => void runBulk({ action: 'unmarkTrending' }, ids, clear, 'Unmark trending')}>Unmark trending</button>
              <button type="button" className={bulkButton} onClick={() => setTaxonomy({ kind: 'type', ids: ids.map(Number), clear })}>Set type…</button>
              <button type="button" className={bulkButton} onClick={() => setTaxonomy({ kind: 'category', ids: ids.map(Number), clear })}>Set category…</button>
            </>}
          </>
        )} />
      <AddProductDialog open={adding} onOpenChange={setAdding} types={counts.data?.data ?? []} />
      {drawer !== null && <VariantDrawer productId={drawer} onClose={() => setDrawer(null)} canWrite={canWrite} canPrice={canPrice} />}
      {confirm && (
        <ConfirmDialog open onOpenChange={(o) => { if (!o) setConfirm(null); }} busy={busy} onConfirm={() => void runConfirm()}
          title={confirm.action === 'delete' ? `Delete “${confirm.row.name}”?` : `Archive “${confirm.row.name}”?`}
          description={confirm.action === 'delete' ? 'This draft and its variants are removed permanently.' : 'It is hidden from the storefront and kept for order history. You can publish it again later.'}
          confirmLabel={confirm.action === 'delete' ? 'Delete' : 'Archive'} {...(confirm.action === 'delete' ? { danger: true } : {})} />
      )}
      {bulk && <BulkResults results={bulk.results} rows={bulk.names} onClose={() => setBulk(null)} />}
      {taxonomy && (
        <SetTaxonomyDialog kind={taxonomy.kind} types={counts.data?.data ?? []} onClose={() => setTaxonomy(null)}
          onApply={(tid) => { const t = taxonomy; setTaxonomy(null); void runBulk(t.kind === 'type' ? { action: 'setType', typeId: tid } : { action: 'setCategory', categoryId: tid }, t.ids.map(String), t.clear, t.kind === 'type' ? 'Set type' : 'Set category'); }} />
      )}
    </>
  );
}
