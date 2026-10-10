// Returns & Refunds (product.md §7.5) [returns:receive or refunds:create]. Two queues, one per tab (the tab is in the
// URL, `?view=refunds`): returns (task 5.5) that still need someone by default, filterable by status, each linking to
// its return page; and refunds (task 5.4), newest first, filterable by status, with each refund's order, kind, amount,
// attempts (key, receipt, last HTTP status) and what still needs a person (failed, checking with Razorpay, COD transfers).
import { formatINR, REFUND_STATUSES, RETURN_REQUEST_STATUSES, type AdminRefundRow, type AdminReturnRow } from '@artq/shared';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Link, useSearchParams } from 'react-router';
import type { Page } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { DataTable, useTableParams } from '../../components/DataTable';
import { reasonLabel, RETURN_STATUS, ReturnPill } from '../returns/labels';
import { PageHeader } from '../simple';
import { when } from './labels';
import { KIND_LABEL, REFUND_STATUS, RefundPill } from './refunds';

const select = 'mt-1 block h-11 w-56 rounded-md border border-border-input bg-white px-3';

export function RefundsPage() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const returns = can('returns:receive'), refunds = can('refunds:create');
  const view = !returns || (refunds && sp.get('view') === 'refunds') ? 'refunds' : 'returns';
  const tab = (v: 'returns' | 'refunds') => `${'inline-flex h-11 items-center border-b-2 px-4 font-medium'} ${view === v ? 'border-brand-700 text-ink-900' : 'border-transparent text-ink-700 hover:text-ink-900'}`;
  return (
    <>
      <PageHeader title="Returns & Refunds" />
      {returns && refunds && (
        <div role="tablist" aria-label="Queue" className="mb-4 flex border-b border-surface-200">
          <button type="button" role="tab" aria-selected={view === 'returns'} className={tab('returns')} onClick={() => setSp(new URLSearchParams())}>Returns</button>
          <button type="button" role="tab" aria-selected={view === 'refunds'} className={tab('refunds')} onClick={() => setSp(new URLSearchParams({ view: 'refunds' }))}>Refunds</button>
        </div>
      )}
      {view === 'returns' ? <ReturnsQueue /> : <RefundsQueue />}
    </>
  );
}

function ReturnsQueue() {
  const { api } = useAuth();
  const params = useTableParams({ sort: 'newest', filterKeys: ['status'] });
  // No status chosen = everything still in progress; "all" = every return.
  const status = params.filters.status;
  const query = useQuery({
    queryKey: ['returns', params.page, status ?? 'open'],
    queryFn: () => api.request<Page<AdminReturnRow>>('GET', '/admin/returns', { query: { page: params.page, limit: 25, ...(status === 'all' ? {} : status ? { status } : { open: '1' }) } }),
    placeholderData: (prev) => prev,
  });
  const columns: ColumnDef<AdminReturnRow, unknown>[] = [
    { id: 'return', header: 'Return', cell: ({ row: { original: r } }) => (
      <div><Link to={`/returns/${r.id}`} className="font-medium text-brand-700 underline-offset-2 hover:underline">#{r.id} {reasonLabel(r.reason)}</Link>
        <div className="text-sm text-ink-700"><Link to={`/orders/${r.orderId}`} className="font-mono underline-offset-2 hover:underline">{r.orderNumber}</Link> · {r.customerName}</div></div>
    ) },
    { id: 'units', header: 'Units', cell: ({ row: { original: r } }) => <span className="tabular-nums">{r.units}</span> },
    { id: 'status', header: 'Status', cell: ({ row: { original: r } }) => <ReturnPill status={r.status} /> },
    { id: 'when', header: 'Asked', cell: ({ row: { original: r } }) => <span className="text-sm">{when(r.createdAt)}</span> },
  ];
  return (
    <section aria-labelledby="returns-h" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="returns-h" className="font-semibold text-ink-900">Returns</h2>
        <div className="text-sm text-ink-900">
          <label htmlFor="rt-status">Status</label>
          <select id="rt-status" className={select} value={status ?? ''} onChange={(e) => params.setFilter('status', e.target.value || null)}>
            <option value="">Needs someone</option>
            <option value="all">All returns</option>
            {RETURN_REQUEST_STATUSES.map((s) => <option key={s} value={s}>{RETURN_STATUS[s][0]}</option>)}
          </select>
        </div>
      </div>
      <DataTable caption="Returns" columns={columns} query={query} params={params} getRowId={(r) => String(r.id)} emptyMessage={params.hasFilters ? 'No return with this status.' : 'No return needs anyone right now.'} />
    </section>
  );
}

function RefundsQueue() {
  const { api } = useAuth();
  const params = useTableParams({ sort: 'newest', filterKeys: ['status'] });
  const query = useQuery({
    queryKey: ['refunds', params.page, params.filters],
    queryFn: () => api.request<Page<AdminRefundRow>>('GET', '/admin/refunds', { query: { page: params.page, limit: 25, ...params.filters } }),
    placeholderData: (prev) => prev,
  });
  const columns: ColumnDef<AdminRefundRow, unknown>[] = [
    { id: 'refund', header: 'Refund', cell: ({ row: { original: r } }) => (
      <div><div className="font-medium text-ink-900">#{r.id} {KIND_LABEL[r.kind] ?? r.kind}</div>
        <Link to={`/orders/${r.orderId}`} className="font-mono text-sm text-brand-700 underline-offset-2 hover:underline">{r.orderNumber}</Link></div>
    ) },
    { id: 'amount', header: 'Amount', cell: ({ row: { original: r } }) => <div className="tabular-nums"><div className="font-medium">{formatINR(r.amount)}</div><div className="text-sm text-ink-700">{r.method === 'MANUAL_BANK' ? 'Bank / UPI transfer' : 'To the payment'}</div></div> },
    { id: 'status', header: 'Status', cell: ({ row: { original: r } }) => (
      <div className="space-y-1"><RefundPill status={r.status} />
        {r.failureReason && <div className="text-sm text-danger-700">{r.failureReason}</div>}
        {r.status === 'UNKNOWN' && <div className="text-sm text-ink-700">Checked again every 5 minutes; nothing to do unless it stays here.</div>}
        {r.actions.includes('manual-processed') && <div className="text-sm text-ink-700">Transfer the money, then record it on the order.</div>}</div>
    ) },
    { id: 'attempts', header: 'Attempts', cell: ({ row: { original: r } }) => (r.attempts.length === 0 ? <span className="text-ink-700">—</span> : (
      <ul className="text-xs text-ink-700">{r.attempts.map((a) => <li key={a.no}><span className="font-mono">{a.receipt}</span> · {a.status.toLowerCase()}{a.lastHttpStatus ? ` · HTTP ${a.lastHttpStatus}` : ''}{a.sendCount > 1 ? ` · sent ${a.sendCount}×` : ''}</li>)}</ul>
    )) },
    { id: 'when', header: 'Requested', cell: ({ row: { original: r } }) => <div className="text-sm"><div>{when(r.createdAt)}</div>{r.processedAt && <div className="text-ink-700">Refunded {when(r.processedAt)}</div>}</div> },
  ];
  return (
    <section aria-labelledby="queue-h" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="queue-h" className="font-semibold text-ink-900">Refunds</h2>
        <div className="text-sm text-ink-900">
          <label htmlFor="rf-status">Status</label>
          <select id="rf-status" className={select} value={params.filters.status ?? ''} onChange={(e) => params.setFilter('status', e.target.value || null)}>
            <option value="">Any status</option>
            {REFUND_STATUSES.map((s) => <option key={s} value={s}>{REFUND_STATUS[s][0]}</option>)}
          </select>
        </div>
      </div>
      <DataTable caption="Refunds" columns={columns} query={query} params={params} getRowId={(r) => String(r.id)} emptyMessage={params.hasFilters ? 'No refund with this status.' : 'No refunds yet.'} />
    </section>
  );
}
