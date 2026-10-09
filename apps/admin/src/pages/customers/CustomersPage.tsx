// Customers (task 5.9; product.md §7.5) [customers:read; changes customers:write]. Search by name, email or phone;
// the detail with orders, addresses and the staff note; Block (with a reason; signs them out everywhere) and Unblock.
// Staff without customers:write see contact details masked.
import { customerBlockBody, customerPatchBody, formatINR, type AdminCustomerDetail, type AdminCustomerRow } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import type { z } from 'zod';
import { ApiError, type Page } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { DataTable, useTableParams } from '../../components/DataTable';
import { btn, FormDialog } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { applyServerErrors, FormAlert } from '../../components/form';
import { FULFILMENT_LABEL, ORDER_LABEL, Pill, when } from '../orders/labels';
import { NotFoundPage, PageHeader } from '../simple';

const card = 'rounded-lg border border-surface-200 bg-white p-5';
const outline = `${btn} border border-border-input bg-white`;
const quiet = `${btn} text-ink-900 hover:bg-surface-100`;
const STATUS: Record<string, string> = { ACTIVE: 'Active', BLOCKED: 'Blocked', PENDING_VERIFICATION: 'Email not verified' };

export function CustomersPage() {
  const { api } = useAuth();
  const params = useTableParams({ sort: 'newest', filterKeys: ['q', 'status'] });
  const [text, setText] = useState(params.filters.q ?? '');
  const query = useQuery({ queryKey: ['customers', params.page, params.filters], queryFn: () => api.request<Page<AdminCustomerRow>>('GET', '/admin/customers', { query: { page: params.page, limit: 25, ...params.filters } }), placeholderData: (p) => p });
  const columns: ColumnDef<AdminCustomerRow, unknown>[] = [
    { id: 'name', header: 'Customer', cell: ({ row: { original: c } }) => <div><Link to={`/customers/${c.id}`} className="font-medium text-brand-700 underline-offset-2 hover:underline">{c.name ?? c.email}</Link><div className="text-sm text-ink-700">{c.email}{c.phone ? ` · ${c.phone}` : ''}</div></div> },
    { id: 'orders', header: 'Orders', cell: ({ row: { original: c } }) => <div className="tabular-nums">{c.orders}<div className="text-sm text-ink-700">{formatINR(c.spent)}</div></div> },
    { id: 'status', header: 'Status', cell: ({ row: { original: c } }) => <span className={c.status === 'BLOCKED' ? 'font-semibold text-danger-700' : 'text-ink-900'}>{STATUS[c.status] ?? c.status}</span> },
    { id: 'joined', header: 'Joined', cell: ({ row: { original: c } }) => <div className="text-sm">{when(c.createdAt)}<div className="text-ink-700">{c.lastLoginAt ? `Last login ${when(c.lastLoginAt)}` : 'Never logged in'}</div></div> },
  ];
  return (
    <>
      <PageHeader title="Customers" />
      <form role="search" className="mb-3 flex flex-wrap items-end gap-3 text-sm" onSubmit={(e) => { e.preventDefault(); params.setFilter('q', text.trim() || null); }}>
        <div><label htmlFor="cu-q">Search</label><input id="cu-q" type="search" className="mt-1 block h-11 w-72 rounded-md border border-border-input bg-white px-3" placeholder="Name, email or phone" value={text} onChange={(e) => setText(e.target.value)} maxLength={100} /></div>
        <div><label htmlFor="cu-status">Status</label>
          <select id="cu-status" className="mt-1 block h-11 w-48 rounded-md border border-border-input bg-white px-3" value={params.filters.status ?? ''} onChange={(e) => params.setFilter('status', e.target.value || null)}>
            <option value="">Any status</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></div>
        <button type="submit" className={outline}>Search</button>
      </form>
      <DataTable caption="Customers" columns={columns} query={query} params={params} getRowId={(c) => String(c.id)} emptyMessage={params.hasFilters ? 'No customer matches.' : 'No customers yet.'} />
    </>
  );
}

export function CustomerDetailPage() {
  const id = Number(useParams().id);
  const { api, can } = useAuth();
  const qc = useQueryClient();
  const key = ['customer', id];
  const q = useQuery({ queryKey: key, queryFn: () => api.request<AdminCustomerDetail>('GET', `/admin/customers/${id}`), enabled: Number.isSafeInteger(id) && id > 0, retry: false });
  const [blocking, setBlocking] = useState(false);
  if (!Number.isSafeInteger(id) || id <= 0 || (q.error instanceof ApiError && q.error.status === 404)) return <NotFoundPage />;
  if (q.isPending) return <p role="status" className="text-ink-700">Loading the customer…</p>;
  if (q.isError) return <FormAlert>Couldn’t load this customer. <button type="button" className="underline" onClick={() => void q.refetch()}>Retry</button></FormAlert>;
  const c = q.data;
  const write = can('customers:write');
  const set = (d: AdminCustomerDetail) => { qc.setQueryData(key, d); void qc.invalidateQueries({ queryKey: ['customers'] }); };
  const unblock = async () => {
    try { set(await api.request<AdminCustomerDetail>('POST', `/admin/customers/${id}/unblock`, { body: {} })); toast.success('Customer unblocked'); }
    catch (e) { toast.error(errorMessage(e)); void q.refetch(); }
  };
  return (
    <div className="space-y-5">
      <Link to="/customers" className="inline-flex items-center gap-1 text-sm font-medium text-brand-700"><ArrowLeft size={16} aria-hidden />All customers</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink-900">{c.name ?? c.email}</h1>
          <p className="mt-1 text-sm text-ink-700">{c.email}{c.phone ? ` · ${c.phone}` : ''} · joined {when(c.createdAt)}{c.emailVerified ? '' : ' · email not verified'}</p>
          <p className={`mt-1 text-sm font-semibold ${c.status === 'BLOCKED' ? 'text-danger-700' : 'text-ink-900'}`} aria-label="Account status">{STATUS[c.status] ?? c.status}</p>
        </div>
        {write && (c.status === 'BLOCKED'
          ? <button type="button" className={outline} onClick={() => void unblock()}>Unblock</button>
          : <button type="button" className={`${btn} border border-danger-700 bg-white text-danger-700 hover:bg-[#fee2e2]`} onClick={() => setBlocking(true)}>Block</button>)}
      </div>
      {c.contactMasked && <p className="text-sm text-ink-700">Contact details are partly hidden for your role.</p>}
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[['Orders', String(c.orders)], ['Spent', formatINR(c.spent)], ['Wishlist', String(c.wishlistCount)], ['Marketing emails', c.marketingOptIn ? 'Yes' : 'No']].map(([l, v]) => <div key={l} className={card}><dt className="text-sm text-ink-700">{l}</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{v}</dd></div>)}
      </dl>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section aria-labelledby="co-h" className={card}>
          <h2 id="co-h" className="mb-3 font-semibold text-ink-900">Recent orders</h2>
          {c.recentOrders.length === 0 ? <p className="text-sm text-ink-700">No orders yet.</p> : (
            <ul className="divide-y divide-surface-100 text-sm">{c.recentOrders.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{can('orders:read') ? <Link to={`/orders/${o.id}`} className="font-mono text-brand-700 underline-offset-2 hover:underline">{o.orderNumber}</Link> : <span className="font-mono">{o.orderNumber}</span>} <span className="text-ink-700">· {when(o.createdAt)}</span></span>
                <span className="flex flex-wrap items-center gap-2"><Pill label={ORDER_LABEL[o.status as keyof typeof ORDER_LABEL] ?? [o.status, 'plain']} /><Pill label={FULFILMENT_LABEL[o.fulfilmentStatus as keyof typeof FULFILMENT_LABEL] ?? [o.fulfilmentStatus, 'plain']} /><span className="tabular-nums">{formatINR(o.total)}</span></span>
              </li>
            ))}</ul>
          )}
        </section>
        <div className="space-y-5">
          <section aria-labelledby="ca-h" className={card}>
            <h2 id="ca-h" className="mb-3 font-semibold text-ink-900">Addresses</h2>
            {c.addresses.length === 0 ? <p className="text-sm text-ink-700">No saved addresses.</p> : (
              <ul className="space-y-3 text-sm">{c.addresses.map((a) => <li key={a.id}><span className="font-medium">{a.fullName}</span>{a.isDefault ? <span className="text-ink-700"> · default</span> : null}{a.lines.map((l) => <span key={l} className="block">{l}</span>)}<span className="block text-ink-700">{a.phone}</span></li>)}</ul>
            )}
          </section>
          <NotesCard c={c} canEdit={write} onSaved={set} />
        </div>
      </div>
      {blocking && <BlockDialog c={c} onClose={() => setBlocking(false)} onDone={set} />}
    </div>
  );
}

function NotesCard({ c, canEdit, onSaved }: { c: AdminCustomerDetail; canEdit: boolean; onSaved: (d: AdminCustomerDetail) => void }) {
  const { api } = useAuth();
  const [problem, setProblem] = useState<string | null>(null);
  const form = useForm<z.input<typeof customerPatchBody>, unknown, z.output<typeof customerPatchBody>>({ resolver: zodResolver(customerPatchBody), defaultValues: { adminNotes: c.adminNotes ?? '' } });
  const err = form.formState.errors.adminNotes?.message;
  const save = form.handleSubmit(async (body) => {
    setProblem(null);
    try { const d = await api.request<AdminCustomerDetail>('PATCH', `/admin/customers/${c.id}`, { body }); onSaved(d); form.reset({ adminNotes: d.adminNotes ?? '' }); toast.success('Note saved'); }
    catch (e) { if (!applyServerErrors(e, form.setError, ['adminNotes'])) setProblem(errorMessage(e)); }
  });
  return (
    <section aria-labelledby="cn-h" className={card}>
      <h2 id="cn-h" className="mb-3 font-semibold text-ink-900">Staff note</h2>
      {canEdit ? (
        <form noValidate onSubmit={(e) => { void save(e); }} className="space-y-2">
          <label htmlFor="cu-note" className="block text-sm font-medium text-ink-900">Not shown to the customer</label>
          <textarea id="cu-note" rows={4} className="block w-full rounded-md border border-border-input p-2 text-sm" aria-invalid={err ? true : undefined} aria-describedby={err ? 'cu-note-error' : undefined} {...form.register('adminNotes')} />
          {err && <p id="cu-note-error" className="text-sm text-danger-700">{err}</p>}
          {problem && <FormAlert>{problem}</FormAlert>}
          <button type="submit" className={outline} disabled={!form.formState.isDirty || form.formState.isSubmitting}>{form.formState.isSubmitting ? 'Saving…' : 'Save note'}</button>
        </form>
      ) : <p className="text-sm text-ink-700">{c.adminNotes ?? 'No note.'}</p>}
    </section>
  );
}

function BlockDialog({ c, onClose, onDone }: { c: AdminCustomerDetail; onClose: () => void; onDone: (d: AdminCustomerDetail) => void }) {
  const { api } = useAuth();
  const [problem, setProblem] = useState<string | null>(null);
  const form = useForm<z.input<typeof customerBlockBody>>({ resolver: zodResolver(customerBlockBody), defaultValues: { reason: '' } });
  const err = form.formState.errors.reason?.message;
  const save = form.handleSubmit(async (body) => {
    setProblem(null);
    try { onDone(await api.request<AdminCustomerDetail>('POST', `/admin/customers/${c.id}/block`, { body })); toast.success('Customer blocked and signed out everywhere'); onClose(); }
    catch (e) { if (!applyServerErrors(e, form.setError, ['reason'])) setProblem(errorMessage(e)); }
  });
  return (
    <FormDialog open onOpenChange={(v) => { if (!v) onClose(); }} title={`Block ${c.name ?? c.email}?`} description="They are signed out on every device and can’t log in or check out with this account until unblocked. Their orders stay as they are.">
      <form noValidate onSubmit={(e) => { void save(e); }} className="space-y-3">
        <div>
          <label htmlFor="cu-reason" className="block text-sm font-medium text-ink-900">Reason (kept in the audit log)</label>
          <textarea id="cu-reason" rows={3} className="mt-1 block w-full rounded-md border border-border-input p-2 text-sm" aria-invalid={err ? true : undefined} aria-describedby={err ? 'cu-reason-error' : undefined} {...form.register('reason')} />
          {err && <p id="cu-reason-error" className="mt-1 text-sm text-danger-700">{err}</p>}
        </div>
        {problem && <FormAlert>{problem}</FormAlert>}
        <div className="flex justify-end gap-3"><button type="button" className={quiet} onClick={onClose}>Cancel</button><button type="submit" className={`${btn} bg-danger-700 text-white disabled:opacity-80`} disabled={form.formState.isSubmitting}>Block customer</button></div>
      </form>
    </FormDialog>
  );
}

