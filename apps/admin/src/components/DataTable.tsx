// Server-side table (product.md §7.2): page, sort and filters live in the URL; loading = skeleton rows, empty =
// message + "Clear filters", error = "Couldn't load. Retry"; select-all-on-page + bulk actions; Previous / Page X of Y / Next.
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type RowSelectionState } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import type { Page } from '../api/client';

export type TableParams = {
  page: number;
  sort: string;
  filters: Record<string, string>;
  setPage(page: number): void;
  setSort(sort: string): void;
  setFilter(name: string, value: string | null): void;
  clearFilters(): void;
  hasFilters: boolean;
};

/** Reads/writes table state in the URL (`?page=2&sort=-createdAt&action=media.`), so links and reloads keep it. */
export function useTableParams(defaults: { sort: string; filterKeys: string[] }): TableParams {
  const [sp, setSp] = useSearchParams();
  const page = Math.max(1, Number(sp.get('page')) || 1);
  const sort = sp.get('sort') ?? defaults.sort;
  const filters = Object.fromEntries(defaults.filterKeys.map((k) => [k, sp.get(k) ?? '']).filter(([, v]) => v !== ''));
  const update = (fn: (p: URLSearchParams) => void) => setSp((prev) => { const p = new URLSearchParams(prev); fn(p); return p; });
  return {
    page, sort, filters, hasFilters: Object.keys(filters).length > 0,
    setPage: (n) => update((p) => { if (n <= 1) p.delete('page'); else p.set('page', String(n)); }),
    setSort: (s) => update((p) => { if (s === defaults.sort) p.delete('sort'); else p.set('sort', s); p.delete('page'); }),
    setFilter: (k, v) => update((p) => { if (v) p.set(k, v); else p.delete(k); p.delete('page'); }),
    clearFilters: () => update((p) => { for (const k of defaults.filterKeys) p.delete(k); p.delete('page'); }),
  };
}

export type ColumnMeta = { sortKey?: string; className?: string };

type QueryLike<T> = { data: Page<T> | undefined; isPending: boolean; isError: boolean; error: unknown; isFetching: boolean; refetch: () => unknown };

export type DataTableProps<T> = {
  caption: string;
  columns: ColumnDef<T, unknown>[];
  query: QueryLike<T>;
  params: TableParams;
  getRowId: (row: T) => string;
  emptyMessage: string;
  selectable?: boolean;
  bulkActions?: (selectedIds: string[], clear: () => void) => ReactNode;
  skeletonRows?: number;
};

export function DataTable<T>({ caption, columns, query, params, getRowId, emptyMessage, selectable, bulkActions, skeletonRows = 8 }: DataTableProps<T>) {
  const [selection, setSelection] = useState<RowSelectionState>({});
  const rows = query.data?.data ?? [];
  const meta = query.data?.meta;
  // Selection is per page: changing page, sort or filters clears it.
  const key = `${params.page}|${params.sort}|${JSON.stringify(params.filters)}`;
  useEffect(() => { setSelection({}); }, [key]);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table returns non-memoizable functions; the React Compiler correctly skips this component
  const table = useReactTable({
    data: rows,
    columns,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    enableRowSelection: !!selectable,
    state: { rowSelection: selection },
    onRowSelectionChange: setSelection,
  });
  const selectedIds = Object.keys(selection).filter((k) => selection[k]);
  const colCount = columns.length + (selectable ? 1 : 0);

  return (
    <div className="rounded-lg border border-surface-200 bg-white" aria-busy={query.isFetching || undefined}>
      {selectable && selectedIds.length > 0 && bulkActions && (
        <div className="flex flex-wrap items-center gap-3 border-b border-surface-200 bg-brand-50 px-4 py-2 text-sm" role="region" aria-label="Bulk actions">
          <span className="font-medium text-ink-900">{selectedIds.length} selected</span>
          {bulkActions(selectedIds, () => setSelection({}))}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-surface-100 text-ink-700">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {selectable && (
                  <th scope="col" className="w-12 px-4 py-3">
                    <HeaderCheckbox checked={table.getIsAllPageRowsSelected()} indeterminate={table.getIsSomePageRowsSelected()} disabled={rows.length === 0} onChange={(v) => table.toggleAllPageRowsSelected(v)} />
                  </th>
                )}
                {hg.headers.map((h) => {
                  const m = h.column.columnDef.meta as ColumnMeta | undefined;
                  const sortKey = m?.sortKey;
                  const dir = sortKey && params.sort === sortKey ? 'ascending' : sortKey && params.sort === `-${sortKey}` ? 'descending' : undefined;
                  return (
                    <th key={h.id} scope="col" className={`px-4 py-3 font-semibold ${m?.className ?? ''}`} aria-sort={sortKey ? (dir ?? 'none') : undefined}>
                      {sortKey ? (
                        <button type="button" className="inline-flex items-center gap-1 rounded hover:text-ink-900" onClick={() => params.setSort(dir === 'descending' ? sortKey : `-${sortKey}`)}>
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {dir === 'ascending' ? <ArrowUp aria-hidden size={14} /> : dir === 'descending' ? <ArrowDown aria-hidden size={14} /> : <ArrowUpDown aria-hidden size={14} />}
                        </button>
                      ) : flexRender(h.column.columnDef.header, h.getContext())}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {query.isPending && Array.from({ length: skeletonRows }, (_, i) => (
              <tr key={`sk${i}`} className="h-12 border-t border-surface-200" data-testid="skeleton-row">
                {Array.from({ length: colCount }, (__, j) => <td key={j} className="px-4"><div className="h-3 w-3/4 animate-pulse rounded bg-surface-200" /></td>)}
              </tr>
            ))}
            {query.isError && (
              <tr className="border-t border-surface-200"><td colSpan={colCount} className="px-4 py-10 text-center" role="alert">
                <p className="mb-3 text-ink-700">Couldn&apos;t load. {errorText(query.error)}</p>
                <button type="button" className="h-11 rounded-md border border-border-input px-4 font-medium text-ink-900 hover:bg-surface-100" onClick={() => void query.refetch()}>Retry</button>
              </td></tr>
            )}
            {!query.isPending && !query.isError && rows.length === 0 && (
              <tr className="border-t border-surface-200"><td colSpan={colCount} className="px-4 py-10 text-center">
                <p className="text-ink-700">{emptyMessage}</p>
                {params.hasFilters && <button type="button" className="mt-3 h-11 rounded-md px-4 font-medium text-brand-700 underline" onClick={params.clearFilters}>Clear filters</button>}
              </td></tr>
            )}
            {!query.isPending && !query.isError && table.getRowModel().rows.map((r) => (
              <tr key={r.id} className="h-12 border-t border-surface-200 hover:bg-surface-50" aria-selected={selectable ? r.getIsSelected() : undefined}>
                {selectable && <td className="px-4"><input type="checkbox" className="h-4 w-4 accent-brand-700" aria-label={`Select row ${r.id}`} checked={r.getIsSelected()} onChange={r.getToggleSelectedHandler()} /></td>}
                {r.getVisibleCells().map((c) => <td key={c.id} className={`px-4 ${(c.column.columnDef.meta as ColumnMeta | undefined)?.className ?? ''}`}>{flexRender(c.column.columnDef.cell, c.getContext())}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav className="flex items-center justify-between gap-3 border-t border-surface-200 px-4 py-3 text-sm" aria-label="Pagination">
        <button type="button" className="h-11 rounded-md px-3 font-medium text-ink-900 enabled:hover:bg-surface-100 disabled:text-ink-500" disabled={!meta || params.page <= 1} onClick={() => params.setPage(params.page - 1)}>‹ Previous</button>
        <span className="text-ink-700" aria-live="polite">{meta ? `Page ${meta.page} of ${meta.totalPages} · ${meta.total} total` : ' '}</span>
        <button type="button" className="h-11 rounded-md px-3 font-medium text-ink-900 enabled:hover:bg-surface-100 disabled:text-ink-500" disabled={!meta || params.page >= meta.totalPages} onClick={() => params.setPage(params.page + 1)}>Next ›</button>
      </nav>
    </div>
  );
}

function HeaderCheckbox({ checked, indeterminate, disabled, onChange }: { checked: boolean; indeterminate: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate && !checked; }, [indeterminate, checked]);
  return <input ref={ref} type="checkbox" className="h-4 w-4 accent-brand-700" aria-label="Select all rows on this page" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;
}

function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : '';
}
