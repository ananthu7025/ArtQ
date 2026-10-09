// Payment Exceptions (task 5.8; product.md §7.5) [payments:exceptions]. The queue of money and stock problems the system
// could not settle on its own: what still needs someone by default, filterable by status and type, each explained in
// staff words with what to do; Resolve (what you did) or Dismiss (why nothing is needed), each with a note checked by
// the shared schema; Reconcile with Razorpay for one order or for all open payments and refunds.
import { EXCEPTION_HELP, EXCEPTION_STATUSES, EXCEPTION_TYPES, exceptionDismissBody, exceptionResolveBody, formatINR, type AdminExceptionRow } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ApiError, type Page } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { DataTable, useTableParams } from '../../components/DataTable';
import { btn, FormDialog } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { applyServerErrors, FormAlert } from '../../components/form';
import { when } from '../orders/labels';
import { PageHeader } from '../simple';

const primary = `${btn} bg-brand-700 text-white disabled:opacity-80`;
const outline = `${btn} border border-border-input bg-white`;
const quiet = `${btn} text-ink-900 hover:bg-surface-100`;
const select = 'mt-1 block h-11 w-60 rounded-md border border-border-input bg-white px-3';
const STATUS: Record<string, [string, string]> = {
  OPEN: ['Open', 'bg-[#fee2e2] text-danger-700'], AUTO_RESOLVING: ['Resolving itself', 'bg-warning-bg text-warning-ink'],
  RESOLVED: ['Resolved', 'bg-[#dcfce7] text-success-700'], DISMISSED: ['Dismissed', 'bg-surface-100 text-ink-700'],
};
const age = (m: number) => (m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} days`);

export function PaymentExceptionsPage() {
  const { api } = useAuth();
  const params = useTableParams({ sort: 'newest', filterKeys: ['status', 'type'] });
  const [closing, setClosing] = useState<{ row: AdminExceptionRow; to: 'resolve' | 'dismiss' } | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const status = params.filters.status;
  const query = useQuery({
    queryKey: ['payment-exceptions', params.page, params.filters],
    queryFn: () => api.request<Page<AdminExceptionRow>>('GET', '/admin/payment-exceptions', { query: { page: params.page, limit: 25, ...(params.filters.type ? { type: params.filters.type } : {}), ...(status === 'all' ? {} : status ? { status } : { open: '1' }) } }),
    placeholderData: (prev) => prev,
  });
  const columns: ColumnDef<AdminExceptionRow, unknown>[] = [
    { id: 'what', header: 'Problem', cell: ({ row: { original: r } }) => (
      <div className="max-w-xl">
        <div className="font-medium text-ink-900">{EXCEPTION_HELP[r.type]?.title ?? r.type}</div>
        <div className="text-sm text-ink-700">{EXCEPTION_HELP[r.type]?.action}</div>
        <div className="mt-1 text-xs text-ink-700">
          {r.order && <><Link to={`/orders/${r.order.id}`} className="font-mono text-brand-700 underline-offset-2 hover:underline">{r.order.orderNumber}</Link> · </>}
          {r.paymentId && <><span className="font-mono">{r.paymentId}</span> · </>}{r.refundId && <>refund #{r.refundId} · </>}<span className="font-mono">{r.type}</span>
        </div>
        {r.resolution && <div className="mt-1 text-sm text-ink-900">{r.status === 'DISMISSED' ? 'Dismissed' : 'Resolved'}{r.resolvedBy ? ` by ${r.resolvedBy}` : ''}: {r.resolution}</div>}
      </div>
    ) },
    { id: 'amount', header: 'Amount', cell: ({ row: { original: r } }) => <span className="tabular-nums">{r.amount === null ? '—' : formatINR(Math.abs(r.amount))}</span> },
    { id: 'status', header: 'Status', cell: ({ row: { original: r } }) => <div><span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS[r.status]![1]}`}>{STATUS[r.status]![0]}</span><div className="mt-1 text-xs text-ink-700" title={when(r.createdAt)}>{age(r.ageMinutes)} ago</div></div> },
    { id: 'actions', header: 'Actions', cell: ({ row: { original: r } }) => (['OPEN', 'AUTO_RESOLVING'].includes(r.status) ? (
      <div className="flex flex-wrap gap-2">
        <button type="button" className={outline} onClick={() => setClosing({ row: r, to: 'resolve' })} aria-label={`Resolve exception #${r.id}`}>Resolve</button>
        <button type="button" className={quiet} onClick={() => setClosing({ row: r, to: 'dismiss' })} aria-label={`Dismiss exception #${r.id}`}>Dismiss</button>
      </div>
    ) : null) },
  ];
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title="Payment Exceptions" />
        <button type="button" className={outline} onClick={() => setReconciling(true)}>Reconcile with Razorpay</button>
      </div>
      <div className="mb-3 flex flex-wrap items-end gap-4 text-sm text-ink-900">
        <div><label htmlFor="ex-status">Status</label>
          <select id="ex-status" className={select} value={status ?? ''} onChange={(e) => params.setFilter('status', e.target.value || null)}>
            <option value="">Needs someone</option><option value="all">All</option>
            {EXCEPTION_STATUSES.map((s) => <option key={s} value={s}>{STATUS[s]![0]}</option>)}
          </select></div>
        <div><label htmlFor="ex-type">Type</label>
          <select id="ex-type" className={select} value={params.filters.type ?? ''} onChange={(e) => params.setFilter('type', e.target.value || null)}>
            <option value="">Any type</option>
            {EXCEPTION_TYPES.map((t) => <option key={t} value={t}>{EXCEPTION_HELP[t].title}</option>)}
          </select></div>
      </div>
      <DataTable caption="Payment exceptions" columns={columns} query={query} params={params} getRowId={(r) => String(r.id)} emptyMessage={params.hasFilters ? 'No exception matches.' : 'Nothing needs attention.'} />
      {closing && <CloseDialog {...closing} onClose={() => setClosing(null)} onDone={() => void query.refetch()} />}
      {reconciling && <ReconcileDialog onClose={() => setReconciling(false)} onDone={() => void query.refetch()} />}
    </>
  );
}

function CloseDialog({ row, to, onClose, onDone }: { row: AdminExceptionRow; to: 'resolve' | 'dismiss'; onClose: () => void; onDone: () => void }) {
  const { api } = useAuth();
  const qc = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const field = to === 'resolve' ? 'resolution' : 'note';
  const form = useForm<{ resolution?: string; note?: string }>({ resolver: zodResolver(to === 'resolve' ? exceptionResolveBody : exceptionDismissBody) as never, defaultValues: { [field]: '' } });
  const err = form.formState.errors[field]?.message;
  const save = form.handleSubmit(async (body) => {
    setProblem(null);
    try {
      await api.request('POST', `/admin/payment-exceptions/${row.id}/${to}`, { body });
      toast.success(to === 'resolve' ? 'Exception resolved' : 'Exception dismissed');
      if (row.order) void qc.invalidateQueries({ queryKey: ['order', row.order.id] });
      onDone(); onClose();
    } catch (e) {
      if (applyServerErrors(e, form.setError, [field])) return;
      if (e instanceof ApiError && e.code === 'INVALID_TRANSITION') { toast.error(e.message); onDone(); onClose(); return; }
      setProblem(errorMessage(e));
    }
  });
  const label = to === 'resolve' ? 'What did you do?' : 'Why does it need no action?';
  return (
    <FormDialog open onOpenChange={(v) => { if (!v) onClose(); }} title={to === 'resolve' ? 'Resolve this exception' : 'Dismiss this exception'} description={EXCEPTION_HELP[row.type]?.title ?? row.type}>
      <form noValidate onSubmit={(e) => { void save(e); }} className="space-y-3">
        <div>
          <label htmlFor="ex-note" className="block text-sm font-medium text-ink-900">{label}</label>
          <textarea id="ex-note" rows={3} className="mt-1 block w-full rounded-md border border-border-input p-2 text-sm" aria-invalid={err ? true : undefined} aria-describedby={err ? 'ex-note-error' : undefined} {...form.register(field)} />
          {err && <p id="ex-note-error" className="mt-1 text-sm text-danger-700">{err}</p>}
        </div>
        {problem && <FormAlert>{problem}</FormAlert>}
        <div className="flex justify-end gap-3"><button type="button" className={quiet} onClick={onClose}>Cancel</button><button type="submit" className={primary} disabled={form.formState.isSubmitting}>{to === 'resolve' ? 'Resolve' : 'Dismiss'}</button></div>
      </form>
    </FormDialog>
  );
}

function ReconcileDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { api } = useAuth();
  const [orderNumber, setOrderNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setProblem(null);
    try {
      let orderId: number | undefined;
      if (orderNumber.trim()) {
        const found = await api.request<Page<{ id: number; orderNumber: string }>>('GET', '/admin/orders', { query: { q: orderNumber.trim(), limit: 1 } });
        const hit = found.data.find((o) => o.orderNumber.toUpperCase() === orderNumber.trim().toUpperCase());
        if (!hit) { setProblem('No order with this number.'); return; }
        orderId = hit.id;
      }
      const r = await api.request<{ applied: number; refunds: Record<string, number> }>('POST', '/admin/payments/reconcile', { body: orderId ? { orderId } : {} });
      toast.success(orderId ? `Checked with Razorpay: ${r.applied} payment(s) applied` : 'Checked open payments and refunds with Razorpay');
      onDone(); onClose();
    } catch (e) { setProblem(errorMessage(e)); }
    finally { setBusy(false); }
  };
  return (
    <FormDialog open onOpenChange={(v) => { if (!v) onClose(); }} title="Reconcile with Razorpay" description="Re-reads Razorpay now (it also happens automatically every few minutes). Nothing is ever applied twice.">
      <div className="space-y-3">
        <div>
          <label htmlFor="rc-order" className="block text-sm font-medium text-ink-900">Order number (optional)</label>
          <input id="rc-order" className="mt-1 block h-11 w-full rounded-md border border-border-input px-3" placeholder="AQ10234" value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} />
          <p className="mt-1 text-xs text-ink-700">Leave empty to check every open payment and refund.</p>
        </div>
        {problem && <FormAlert>{problem}</FormAlert>}
        <div className="flex justify-end gap-3"><button type="button" className={quiet} onClick={onClose}>Cancel</button><button type="button" className={primary} disabled={busy} onClick={() => void run()}>{busy ? 'Checking…' : 'Reconcile'}</button></div>
      </div>
    </FormDialog>
  );
}
