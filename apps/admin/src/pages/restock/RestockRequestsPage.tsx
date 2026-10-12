// Restock Requests (task 5.9; product.md §7.5) [restock:read; notify / remove restock:notify]. Customers waiting for a
// sold-out size, grouped by variant: how many, since when, and how many can be bought now. "Notify now" emails everyone
// waiting once the size is available (at most once a day per size; it also happens automatically when stock comes
// back). The emails behind a group can be listed (masked without customers:write) and a request removed.
import type { RestockGroup, RestockRequestRow } from '@artq/shared';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { Page } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { DataTable, useTableParams } from '../../components/DataTable';
import { btn, FormDialog } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { when } from '../orders/labels';
import { PageHeader } from '../simple';

const outline = `${btn} h-9 border border-border-input bg-white px-3 text-sm`;

export function RestockRequestsPage() {
  const { api, can } = useAuth();
  const params = useTableParams({ sort: 'most', filterKeys: ['available'] });
  const [open, setOpen] = useState<RestockGroup | null>(null);
  const query = useQuery({ queryKey: ['restock', params.page, params.filters], queryFn: () => api.request<Page<RestockGroup>>('GET', '/admin/restock-requests', { query: { page: params.page, limit: 25, ...params.filters } }), placeholderData: (p) => p });
  const notify = async (g: RestockGroup) => {
    try {
      const r = await api.request<{ queued: boolean; pending: number }>('POST', '/admin/restock-requests/notify', { body: { variantId: g.variantId } });
      toast.success(r.queued ? `Emailing ${r.pending} waiting customer${r.pending === 1 ? '' : 's'}` : 'Already sent today; it goes out again tomorrow if needed');
    } catch (e) { toast.error(errorMessage(e)); }
    void query.refetch();
  };
  const columns: ColumnDef<RestockGroup, unknown>[] = [
    { id: 'product', header: 'Product', cell: ({ row: { original: g } }) => <div>{can('catalog:read') ? <Link to={`/products/${g.product.id}`} className="font-medium text-brand-700 underline-offset-2 hover:underline">{g.product.name}</Link> : <span className="font-medium">{g.product.name}</span>}
      <div className="text-sm text-ink-700">{g.label} · <span className="font-mono">{g.sku}</span>{g.product.status !== 'ACTIVE' ? ' · not live' : ''}</div></div> },
    { id: 'waiting', header: 'Waiting', cell: ({ row: { original: g } }) => <div><button type="button" className="font-semibold tabular-nums text-brand-700 underline-offset-2 hover:underline" aria-label={`Show the ${g.pending} customers waiting for ${g.product.name} ${g.label}`} onClick={() => setOpen(g)}>{g.pending}</button><div className="text-sm text-ink-700">since {when(g.oldestAt)}</div></div> },
    { id: 'available', header: 'Available now', cell: ({ row: { original: g } }) => <span className={`tabular-nums ${g.available > 0 ? 'font-semibold text-success-700' : 'text-ink-700'}`}>{g.available > 0 ? g.available : 'Sold out'}</span> },
    { id: 'action', header: 'Action', cell: ({ row: { original: g } }) => (can('restock:notify') && g.available > 0 && g.product.status === 'ACTIVE'
      ? (g.notifiedToday ? <span className="text-sm text-ink-700">Notified today</span> : <button type="button" className={outline} aria-label={`Notify customers waiting for ${g.product.name} ${g.label}`} onClick={() => void notify(g)}>Notify now</button>)
      : null) },
  ];
  return (
    <>
      <PageHeader title="Restock Requests" />
      <p className="-mt-3 mb-4 text-sm text-ink-700">Customers who asked to be told when a sold-out size is back. They are emailed automatically when stock returns; use Notify now if that was missed.</p>
      <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5 accent-brand-700" checked={params.filters.available === '1'} onChange={(e) => params.setFilter('available', e.target.checked ? '1' : null)} />Only sizes that are back in stock</label>
      <DataTable caption="Restock requests by size" columns={columns} query={query} params={params} getRowId={(g) => String(g.variantId)} emptyMessage={params.hasFilters ? 'No waiting customer for a size that is in stock.' : 'Nobody is waiting for a sold-out size.'} />
      {open && <WaitingDialog g={open} onClose={() => setOpen(null)} onChanged={() => void query.refetch()} />}
    </>
  );
}

function WaitingDialog({ g, onClose, onChanged }: { g: RestockGroup; onClose: () => void; onChanged: () => void }) {
  const { api, can } = useAuth();
  const q = useQuery({ queryKey: ['restock-requests', g.variantId], queryFn: () => api.request<{ data: RestockRequestRow[] }>('GET', `/admin/restock-requests/variants/${g.variantId}`) });
  const remove = async (r: RestockRequestRow) => {
    try { await api.request('DELETE', `/admin/restock-requests/${r.id}`); toast.success('Request removed'); }
    catch (e) { toast.error(errorMessage(e)); }
    void q.refetch(); onChanged();
  };
  return (
    <FormDialog open onOpenChange={(v) => { if (!v) onClose(); }} title={`Waiting for ${g.product.name} (${g.label})`} description="Each is emailed once when the size is back.">
      {q.isPending ? <p role="status" className="text-ink-700">Loading…</p> : (
        <ul className="max-h-80 divide-y divide-surface-100 overflow-y-auto text-sm">
          {(q.data?.data ?? []).map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 py-2">
              <span>{r.email} <span className="text-ink-700">· {when(r.createdAt)}{r.customerId ? ' · has an account' : ''}</span></span>
              {can('restock:notify') && <button type="button" className={`${btn} h-9 px-3 text-sm text-danger-700 hover:bg-[#fee2e2]`} aria-label={`Remove request from ${r.email}`} onClick={() => void remove(r)}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
    </FormDialog>
  );
}
