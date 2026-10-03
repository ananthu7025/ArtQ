// Coupons (product.md §7 "Coupons", api.md §4.8) [coupons:write]: list with state and uses; create and edit on their own
// page (CouponEditorPage). A coupon's discount cannot change after it has been used.
import { COUPON_STATES, couponSummary, type CouponAdminView, type CouponState } from '@artq/shared';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Link } from 'react-router';
import type { Page } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { DataTable, useTableParams } from '../../components/DataTable';
import { btn } from '../../components/dialogs';
import { PageHeader } from '../simple';

const pill = 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold';
export const STATE_LABEL: Record<CouponState, string> = { active: 'Active', scheduled: 'Scheduled', expired: 'Expired', inactive: 'Off' };
const STATE_CLASS: Record<CouponState, string> = { active: 'bg-[#dcfce7] text-success-700', scheduled: 'bg-warning-bg text-warning-ink', expired: 'bg-surface-100 text-ink-700', inactive: 'bg-surface-100 text-ink-700' };
export const StatePill = ({ state }: { state: CouponState }) => <span className={`${pill} ${STATE_CLASS[state]}`}>{STATE_LABEL[state]}</span>;
const date = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

export function usesText(c: Pick<CouponAdminView, 'redeemedCount' | 'reservedCount' | 'usageLimitTotal'>) {
  const used = `${c.redeemedCount} used${c.reservedCount ? `, ${c.reservedCount} at checkout` : ''}`;
  return c.usageLimitTotal === null ? used : `${used} of ${c.usageLimitTotal}`;
}
function windowText(c: CouponAdminView) {
  if (!c.startsAt && !c.endsAt) return 'No end date';
  if (c.startsAt && c.endsAt) return `${date.format(new Date(c.startsAt))} – ${date.format(new Date(c.endsAt))}`;
  return c.startsAt ? `From ${date.format(new Date(c.startsAt))}` : `Until ${date.format(new Date(c.endsAt!))}`;
}

export function CouponsPage() {
  const { api } = useAuth();
  const params = useTableParams({ sort: 'newest', filterKeys: ['q', 'state'] });
  const query = useQuery({
    queryKey: ['coupons', params.page, params.filters],
    queryFn: () => api.request<Page<CouponAdminView>>('GET', '/admin/coupons', { query: { page: params.page, limit: 25, ...params.filters } }),
    placeholderData: (prev) => prev,
  });
  const columns: ColumnDef<CouponAdminView, unknown>[] = [
    { id: 'code', header: 'Coupon', cell: ({ row }) => (
      <div><Link to={`/coupons/${row.original.id}`} className="font-mono font-semibold text-brand-700 underline-offset-2 hover:underline">{row.original.code}</Link>
        <div className="text-sm text-ink-700">{row.original.title}{row.original.isPublic && <span className="ml-2 text-xs">· shown to customers</span>}</div></div>
    ) },
    { id: 'discount', header: 'Discount', cell: ({ row }) => couponSummary(row.original) },
    { id: 'uses', header: 'Uses', cell: ({ row }) => usesText(row.original), meta: { className: 'whitespace-nowrap' } },
    { id: 'window', header: 'Valid', cell: ({ row }) => windowText(row.original) },
    { id: 'state', header: 'Status', cell: ({ row }) => <StatePill state={row.original.state} /> },
  ];
  return (
    <>
      <PageHeader title="Coupons">
        <Link to="/coupons/new" className={`${btn} bg-brand-700 text-white`}>New coupon</Link>
      </PageHeader>
      <form className="mb-4 flex flex-wrap items-end gap-3" role="search" onSubmit={(e) => e.preventDefault()}>
        <label className="text-sm text-ink-900">Search code or title
          <input className="mt-1 block h-11 w-64 rounded-md border border-border-input px-3" defaultValue={params.filters.q ?? ''} key={params.filters.q ?? ''}
            onBlur={(e) => params.setFilter('q', e.target.value.trim() || null)} onKeyDown={(e) => { if (e.key === 'Enter') params.setFilter('q', (e.target as HTMLInputElement).value.trim() || null); }} />
        </label>
        <label className="text-sm text-ink-900">Status
          <select className="mt-1 block h-11 w-44 rounded-md border border-border-input bg-white px-3" value={params.filters.state ?? ''} onChange={(e) => params.setFilter('state', e.target.value || null)}>
            <option value="">Any status</option>
            {COUPON_STATES.map((s) => <option key={s} value={s}>{STATE_LABEL[s]}</option>)}
          </select>
        </label>
      </form>
      <DataTable caption="Coupons" columns={columns} query={query} params={params} getRowId={(r) => String(r.id)} emptyMessage="No coupons yet. Create one with “New coupon”." />
    </>
  );
}
