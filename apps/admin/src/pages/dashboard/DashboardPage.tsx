// Dashboard (task 5.9; product.md §7.5) [dashboard:read]. Today / 7 days / 30 days (India time): revenue after
// refunds, orders, average order value, new customers; the sales chart; what is waiting for someone, each a link to
// where it is done; low stock; top products.
import { DASHBOARD_RANGES, formatINR, type Dashboard } from '@artq/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { FormAlert } from '../../components/form';
import { ORDER_LABEL } from '../orders/labels';
import { PageHeader } from '../simple';

const card = 'rounded-lg border border-surface-200 bg-white p-5';
const RANGE_LABEL: Record<Dashboard['range'], string> = { today: 'Today', '7d': '7 days', '30d': '30 days' };

export function DashboardPage() {
  const { api, state, can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const range = (DASHBOARD_RANGES as readonly string[]).includes(sp.get('range') ?? '') ? (sp.get('range') as Dashboard['range']) : '7d';
  const q = useQuery({ queryKey: ['dashboard', range], queryFn: () => api.request<Dashboard>('GET', '/admin/dashboard', { query: { range } }), refetchInterval: 60_000, placeholderData: (p) => p });
  const name = state.status === 'authenticated' ? (state.user.name ?? state.user.email) : '';
  const d = q.data;
  const pending: { key: keyof Dashboard['pendingActions']; label: string; to: string; show: boolean }[] = [
    { key: 'toConfirm', label: 'Orders to confirm', to: '/orders?status=PLACED', show: can('orders:read') },
    { key: 'toPack', label: 'Orders to pack', to: '/orders?status=CONFIRMED&fulfilmentStatus=UNFULFILLED', show: can('orders:read') },
    { key: 'toShip', label: 'Orders to ship', to: '/orders?status=CONFIRMED&fulfilmentStatus=PACKED', show: can('orders:read') },
    { key: 'returnsToDecide', label: 'Returns to decide', to: '/returns?status=REQUESTED', show: can('returns:receive') },
    { key: 'openExceptions', label: 'Payment exceptions', to: '/payment-exceptions', show: can('payments:exceptions') },
    { key: 'restockRequests', label: 'Customers waiting for stock', to: '/restock-requests', show: can('restock:read') },
    { key: 'codOverdue', label: 'COD cash overdue', to: '/cod-remittances?overdue=1', show: can('cod:remit') },
  ];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><PageHeader title="Dashboard" /><p className="-mt-3 text-sm text-ink-700">Welcome, {name}.</p></div>
        <div role="group" aria-label="Period" className="inline-flex rounded-md border border-border-input bg-white p-1">
          {DASHBOARD_RANGES.map((r) => <button key={r} type="button" aria-pressed={range === r} onClick={() => setSp(r === '7d' ? new URLSearchParams() : new URLSearchParams({ range: r }))}
            className={`h-9 rounded px-3 text-sm font-medium ${range === r ? 'bg-brand-700 text-white' : 'text-ink-900 hover:bg-surface-100'}`}>{RANGE_LABEL[r]}</button>)}
        </div>
      </div>
      {q.isError && <FormAlert>Couldn’t load the dashboard. <button type="button" className="underline" onClick={() => void q.refetch()}>Retry</button></FormAlert>}
      {!d ? (q.isPending && <p role="status" className="text-ink-700">Loading the figures…</p>) : (
        <>
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[['Revenue', formatINR(d.revenue), 'after refunds'], ['Orders', d.orders.toLocaleString('en-IN'), 'placed, not cancelled'], ['Average order', formatINR(d.aov), ''], ['New customers', d.newCustomers.toLocaleString('en-IN'), 'accounts created']].map(([label, value, hint]) => (
              <div key={label} className={card}><dt className="text-sm text-ink-700">{label}</dt><dd className="mt-1 text-2xl font-semibold tabular-nums text-ink-900">{value}</dd>{hint && <dd className="text-xs text-ink-700">{hint}</dd>}</div>
            ))}
          </dl>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <section aria-labelledby="sales-h" className={card}>
              <h2 id="sales-h" className="mb-3 font-semibold text-ink-900">Sales · {RANGE_LABEL[d.range]}</h2>
              <SalesChart series={d.salesSeries} />
            </section>
            <section aria-labelledby="waiting-h" className={card}>
              <h2 id="waiting-h" className="mb-3 font-semibold text-ink-900">Waiting for you</h2>
              <ul className="space-y-1">
                {pending.filter((p) => p.show).map((p) => (
                  <li key={p.key}><Link to={p.to} className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-surface-100">
                    <span className="text-ink-900">{p.label}</span><span className={`tabular-nums font-semibold ${d.pendingActions[p.key] ? 'text-brand-700' : 'text-ink-700'}`}>{d.pendingActions[p.key] ?? '—'}</span></Link></li>
                ))}
              </ul>
            </section>
          </div>
          <div className="grid gap-5 lg:grid-cols-3">
            <section aria-labelledby="status-h" className={card}>
              <h2 id="status-h" className="mb-3 font-semibold text-ink-900">Orders by status</h2>
              {Object.keys(d.ordersByStatus).length === 0 ? <p className="text-sm text-ink-700">No orders in this period.</p> : (
                <ul className="space-y-1 text-sm">{Object.entries(d.ordersByStatus).map(([s, n]) => <li key={s} className="flex justify-between"><span>{ORDER_LABEL[s as keyof typeof ORDER_LABEL]?.[0] ?? s}</span><span className="tabular-nums">{n}</span></li>)}</ul>
              )}
            </section>
            <section aria-labelledby="top-h" className={card}>
              <h2 id="top-h" className="mb-3 font-semibold text-ink-900">Top products</h2>
              {d.topProducts.length === 0 ? <p className="text-sm text-ink-700">No sales in this period.</p> : (
                <ol className="space-y-1 text-sm">{d.topProducts.map((t) => <li key={`${t.productId}-${t.name}`} className="flex justify-between gap-2">
                  <span className="min-w-0 truncate">{t.productId && can('catalog:read') ? <Link to={`/products/${t.productId}`} className="hover:underline">{t.name}</Link> : t.name}</span>
                  <span className="whitespace-nowrap tabular-nums">{t.units} · {formatINR(t.revenue)}</span></li>)}</ol>
              )}
            </section>
            <section aria-labelledby="low-h" className={card}>
              <h2 id="low-h" className="mb-3 font-semibold text-ink-900">Low stock</h2>
              {d.lowStock.length === 0 ? <p className="text-sm text-ink-700">Nothing is running low.</p> : (
                <ul className="space-y-1 text-sm">{d.lowStock.map((v) => <li key={v.variantId} className="flex justify-between gap-2">
                  <span className="min-w-0 truncate">{can('catalog:read') ? <Link to={`/products/${v.productId}`} className="hover:underline">{v.productName}</Link> : v.productName} <span className="text-ink-700">{v.label}</span></span>
                  <span className={`whitespace-nowrap tabular-nums ${v.available <= 0 ? 'font-semibold text-danger-700' : 'text-warning-ink'}`}>{v.available <= 0 ? 'Sold out' : `${v.available} left`}</span></li>)}</ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

/** Bars to one scale (the highest revenue in the period); every bar has its value as text for screen readers. */
function SalesChart({ series }: { series: Dashboard['salesSeries'] }) {
  const max = Math.max(1, ...series.map((p) => p.revenue));
  const total = series.reduce((s, p) => s + p.revenue, 0);
  if (total === 0) return <p className="text-sm text-ink-700">No sales in this period yet.</p>;
  const every = series.length > 12 ? Math.ceil(series.length / 8) : 1;
  return (
    <figure>
      <div className="flex h-40 items-end gap-[2px]" role="list" aria-label="Revenue per period">
        {series.map((p) => (
          <div key={p.label} role="listitem" className="flex h-full flex-1 flex-col justify-end" title={`${p.label}: ${formatINR(p.revenue)}, ${p.orders} order(s)`}>
            <span className="sr-only">{p.label}: {formatINR(p.revenue)}, {p.orders} order(s)</span>
            <div className="w-full rounded-t bg-brand-700" style={{ height: `${(p.revenue / max) * 100}%`, minHeight: p.revenue ? 2 : 0 }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[2px] text-[10px] text-ink-700" aria-hidden>
        {series.map((p, i) => <span key={p.label} className="flex-1 truncate text-center">{i % every === 0 ? (p.label.length === 10 ? p.label.slice(5) : p.label.slice(0, 2)) : ''}</span>)}
      </div>
      <figcaption className="mt-2 text-xs text-ink-700">Highest: {formatINR(max)}</figcaption>
    </figure>
  );
}
