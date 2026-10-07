// Orders (task 5.1; product.md §7.5 "Orders", api.md §4.3) [orders:read]: newest first, filtered on the server by the
// four status dimensions, payment method, open exceptions, dates and a search (order number, email, phone, name).
// Contact details arrive masked for staff without customers:write.
import {
  FULFILMENT_STATUSES, ORDER_PAYMENT_STATUSES, ORDER_STATUSES, RETURN_STATUSES, formatINR, type AdminOrderRow,
} from '@artq/shared';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle } from 'lucide-react';
import { Link } from 'react-router';
import type { Page } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { DataTable, useTableParams } from '../../components/DataTable';
import { PageHeader } from '../simple';
import { FULFILMENT_LABEL, ORDER_LABEL, PAYMENT_LABEL, Pill, RETURN_LABEL, when } from './labels';

const FILTERS = ['q', 'status', 'paymentStatus', 'fulfilmentStatus', 'returnStatus', 'method', 'exception', 'from', 'to'];
const control = 'mt-1 block h-11 rounded-md border border-border-input bg-white px-3';

export function OrdersPage() {
  const { api } = useAuth();
  const params = useTableParams({ sort: 'newest', filterKeys: FILTERS });
  const f = params.filters;
  const query = useQuery({
    queryKey: ['orders', params.page, f],
    queryFn: () => api.request<Page<AdminOrderRow>>('GET', '/admin/orders', { query: { page: params.page, limit: 25, ...f } }),
    placeholderData: (prev) => prev,
  });
  const columns: ColumnDef<AdminOrderRow, unknown>[] = [
    { id: 'order', header: 'Order', cell: ({ row: { original: o } }) => (
      <div>
        <Link to={`/orders/${o.id}`} className="font-mono font-semibold text-brand-700 underline-offset-2 hover:underline">{o.orderNumber}</Link>
        {o.hasOpenException && <span className="ml-2 inline-flex items-center gap-1 text-xs font-semibold text-danger-700"><AlertTriangle size={14} aria-hidden />Exception</span>}
        <div className="text-sm text-ink-700">{when(o.createdAt)}</div>
      </div>
    ) },
    { id: 'customer', header: 'Customer', cell: ({ row: { original: o } }) => (
      <div><div className="font-medium text-ink-900">{o.customer.name}{o.customer.isGuest && <span className="ml-1 text-xs font-normal text-ink-700">(guest)</span>}</div>
        <div className="text-sm text-ink-700">{o.customer.city} {o.customer.pincode}</div></div>
    ) },
    { id: 'total', header: 'Total', cell: ({ row: { original: o } }) => <div className="tabular-nums"><div className="font-medium text-ink-900">{formatINR(o.total)}</div><div className="text-sm text-ink-700">{o.itemCount} item{o.itemCount === 1 ? '' : 's'} · {o.paymentMethod === 'COD' ? 'COD' : 'Online'}</div></div> },
    { id: 'status', header: 'Status', cell: ({ row: { original: o } }) => (
      <div className="flex flex-wrap gap-1">
        <Pill label={ORDER_LABEL[o.status]} /><Pill label={PAYMENT_LABEL[o.paymentStatus]} /><Pill label={FULFILMENT_LABEL[o.fulfilmentStatus]} />
        {o.returnStatus !== 'NONE' && <Pill label={RETURN_LABEL[o.returnStatus]} />}
      </div>
    ) },
  ];
  const select = (id: string, label: string, key: string, values: readonly string[], text: (v: string) => string, width = 'w-48') => (
    <div className="text-sm text-ink-900">
      <label htmlFor={id}>{label}</label>
      <select id={id} className={`${control} ${width}`} value={f[key] ?? ''} onChange={(e) => params.setFilter(key, e.target.value || null)}>
        <option value="">Any</option>
        {values.map((v) => <option key={v} value={v}>{text(v)}</option>)}
      </select>
    </div>
  );
  const search = (v: string) => params.setFilter('q', v.trim() || null);
  return (
    <>
      <PageHeader title="Orders" />
      <form role="search" aria-label="Filter orders" className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(e) => e.preventDefault()}>
        <div className="text-sm text-ink-900">
          <label htmlFor="o-q">Order, email, phone or name</label>
          <input id="o-q" type="search" className={`${control} w-64`} defaultValue={f.q ?? ''} key={f.q ?? ''} onBlur={(e) => search(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') search((e.target as HTMLInputElement).value); }} />
        </div>
        {select('o-status', 'Order', 'status', ORDER_STATUSES, (v) => ORDER_LABEL[v as keyof typeof ORDER_LABEL][0], 'w-44')}
        {select('o-payment', 'Payment', 'paymentStatus', ORDER_PAYMENT_STATUSES, (v) => PAYMENT_LABEL[v as keyof typeof PAYMENT_LABEL][0])}
        {select('o-fulfilment', 'Fulfilment', 'fulfilmentStatus', FULFILMENT_STATUSES, (v) => FULFILMENT_LABEL[v as keyof typeof FULFILMENT_LABEL][0], 'w-44')}
        {select('o-return', 'Return', 'returnStatus', RETURN_STATUSES, (v) => RETURN_LABEL[v as keyof typeof RETURN_LABEL][0], 'w-36')}
        {select('o-method', 'Method', 'method', ['RAZORPAY', 'COD'], (v) => (v === 'COD' ? 'Cash on delivery' : 'Online'), 'w-40')}
        <div className="text-sm text-ink-900"><label htmlFor="o-from">From</label><input id="o-from" type="date" className={`${control} w-40`} value={f.from ?? ''} onChange={(e) => params.setFilter('from', e.target.value || null)} /></div>
        <div className="text-sm text-ink-900"><label htmlFor="o-to">To</label><input id="o-to" type="date" className={`${control} w-40`} value={f.to ?? ''} min={f.from} onChange={(e) => params.setFilter('to', e.target.value || null)} /></div>
        <label className="flex h-11 items-center gap-2 text-sm text-ink-900"><input type="checkbox" className="h-5 w-5 accent-brand-700" checked={f.exception === '1'} onChange={(e) => params.setFilter('exception', e.target.checked ? '1' : null)} />Open exceptions only</label>
        {params.hasFilters && <button type="button" className="h-11 text-sm font-medium text-brand-700 underline" onClick={params.clearFilters}>Clear filters</button>}
      </form>
      <DataTable caption="Orders" columns={columns} query={query} params={params} getRowId={(o) => String(o.id)}
        emptyMessage={params.hasFilters ? 'No order matches these filters.' : 'No orders yet.'} />
    </>
  );
}
