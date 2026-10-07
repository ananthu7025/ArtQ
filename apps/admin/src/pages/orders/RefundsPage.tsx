// Returns & Refunds (product.md §7.5) [returns:receive or refunds:create]. Task 5.4: the refund queue, newest first,
// filterable by status, with each refund's order, kind, amount, attempts (key, receipt, last HTTP status) and what
// still needs a person (failed, checking with Razorpay, COD transfers to record). Returns join this page in task 5.5.
import { formatINR, REFUND_STATUSES, type AdminRefundRow } from '@artq/shared';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Link } from 'react-router';
import type { Page } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { DataTable, useTableParams } from '../../components/DataTable';
import { PageHeader } from '../simple';
import { when } from './labels';
import { KIND_LABEL, REFUND_STATUS, RefundPill } from './refunds';

export function RefundsPage() {
  const { api, can } = useAuth();
  const params = useTableParams({ sort: 'newest', filterKeys: ['status'] });
  const query = useQuery({
    queryKey: ['refunds', params.page, params.filters],
    queryFn: () => api.request<Page<AdminRefundRow>>('GET', '/admin/refunds', { query: { page: params.page, limit: 25, ...params.filters } }),
    placeholderData: (prev) => prev, enabled: can('refunds:create'),
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
    <>
      <PageHeader title="Returns & Refunds" />
      {!can('refunds:create') ? <p className="text-ink-700">Returns arrive here with task 5.5. Refunds need the refund permission.</p> : (
        <section aria-labelledby="queue-h" className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id="queue-h" className="font-semibold text-ink-900">Refunds</h2>
            <div className="text-sm text-ink-900">
              <label htmlFor="rf-status">Status</label>
              <select id="rf-status" className="mt-1 block h-11 w-56 rounded-md border border-border-input bg-white px-3" value={params.filters.status ?? ''} onChange={(e) => params.setFilter('status', e.target.value || null)}>
                <option value="">Any status</option>
                {REFUND_STATUSES.map((s) => <option key={s} value={s}>{REFUND_STATUS[s][0]}</option>)}
              </select>
            </div>
          </div>
          <DataTable caption="Refunds" columns={columns} query={query} params={params} getRowId={(r) => String(r.id)} emptyMessage={params.hasFilters ? 'No refund with this status.' : 'No refunds yet.'} />
        </section>
      )}
    </>
  );
}
