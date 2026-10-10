// COD Remittances (task 5.6; product.md §7.5, architecture.md §10.5) [cod:remit]. Two tabs (in the URL, `?view=payouts`):
// "Waiting for cash", the delivered cash-on-delivery orders the courier hasn't paid out yet (oldest first, overdue
// after 14 days, filter by courier), with a summary; and "Payouts", the remittances recorded so far. "Record payout"
// takes the courier's reference, date and amount and the orders it covers (ticked from the waiting list, each with the
// amount the courier paid for it); the shared codRemittanceBody checks it, the server's refusals land on their field,
// and orders paid a different amount than their total are flagged as payment exceptions.
import { codRemittanceBody, COD_OVERDUE_DAYS, formatINR, type CodOutstandingRow, type CodOutstandingSummary, type CodRemittanceResult, type CodRemittanceRow } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ApiError, type Page } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { DataTable, useTableParams } from '../../components/DataTable';
import { btn, FormDialog } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { applyServerErrors, FormAlert, TextField } from '../../components/form';
import { convertedForm, fromPaise, rupeeProblems, toPaise } from '../../components/form-schema';
import { when } from '../orders/labels';
import { PageHeader } from '../simple';

const primary = `${btn} bg-brand-700 text-white disabled:opacity-80`;
const quiet = `${btn} text-ink-900 hover:bg-surface-100`;
type Outstanding = Page<CodOutstandingRow> & { summary: CodOutstandingSummary };
/** Today in India as YYYY-MM-DD. */
const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

export function CodRemittancesPage() {
  const [sp, setSp] = useSearchParams();
  const [recording, setRecording] = useState(false);
  const view = sp.get('view') === 'payouts' ? 'payouts' : 'waiting';
  const tab = (v: string) => `inline-flex h-11 items-center border-b-2 px-4 font-medium ${view === v ? 'border-brand-700 text-ink-900' : 'border-transparent text-ink-700 hover:text-ink-900'}`;
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title="COD Remittances" />
        <button type="button" className={primary} onClick={() => setRecording(true)}>Record payout</button>
      </div>
      <div role="tablist" aria-label="View" className="mb-4 flex border-b border-surface-200">
        <button type="button" role="tab" aria-selected={view === 'waiting'} className={tab('waiting')} onClick={() => setSp(new URLSearchParams())}>Waiting for cash</button>
        <button type="button" role="tab" aria-selected={view === 'payouts'} className={tab('payouts')} onClick={() => setSp(new URLSearchParams({ view: 'payouts' }))}>Payouts</button>
      </div>
      {view === 'waiting' ? <Waiting /> : <Payouts />}
      {recording && <RecordDialog onClose={() => setRecording(false)} />}
    </>
  );
}

function Waiting() {
  const { api } = useAuth();
  const params = useTableParams({ sort: 'oldest', filterKeys: ['courier', 'overdue'] });
  const query = useQuery({
    queryKey: ['cod-outstanding', params.page, params.filters],
    queryFn: () => api.request<Outstanding>('GET', '/admin/cod/outstanding', { query: { page: params.page, limit: 50, ...params.filters } }),
    placeholderData: (prev) => prev,
  });
  const s = query.data?.summary;
  const columns: ColumnDef<CodOutstandingRow, unknown>[] = [
    { id: 'order', header: 'Order', cell: ({ row: { original: r } }) => <div><Link to={`/orders/${r.orderId}`} className="font-mono text-brand-700 underline-offset-2 hover:underline">{r.orderNumber}</Link><div className="text-sm text-ink-700">{r.customerName}</div></div> },
    { id: 'courier', header: 'Courier', cell: ({ row: { original: r } }) => <div className="text-sm">{r.courierName ?? '—'}<div className="font-mono text-xs text-ink-700">{r.awbNumber}</div></div> },
    { id: 'total', header: 'Cash', cell: ({ row: { original: r } }) => <span className="tabular-nums font-medium">{formatINR(r.total)}</span> },
    { id: 'delivered', header: 'Delivered', cell: ({ row: { original: r } }) => (
      <div className="text-sm">{r.deliveredAt ? when(r.deliveredAt) : '—'}<div className={r.overdue ? 'font-semibold text-danger-700' : 'text-ink-700'}>{r.days} day{r.days === 1 ? '' : 's'} ago{r.overdue ? ' · overdue' : ''}</div></div>
    ) },
  ];
  return (
    <section aria-labelledby="waiting-h" className="space-y-3">
      <h2 id="waiting-h" className="sr-only">Waiting for cash</h2>
      {s && <p className="text-sm text-ink-900"><strong className="tabular-nums">{formatINR(s.total)}</strong> from {s.count} order{s.count === 1 ? '' : 's'} not paid out yet{s.overdueCount > 0 && <>; <strong className="text-danger-700">{s.overdueCount} overdue ({formatINR(s.overdueTotal)})</strong>, more than {COD_OVERDUE_DAYS} days</>}.</p>}
      <div className="flex flex-wrap items-end gap-4 text-sm text-ink-900">
        <div><label htmlFor="cod-courier">Courier</label>
          <input id="cod-courier" className="mt-1 block h-11 w-56 rounded-md border border-border-input bg-white px-3" defaultValue={params.filters.courier ?? ''} onKeyDown={(e) => { if (e.key === 'Enter') params.setFilter('courier', e.currentTarget.value.trim() || null); }} onBlur={(e) => params.setFilter('courier', e.target.value.trim() || null)} /></div>
        <label className="flex h-11 items-center gap-2"><input type="checkbox" className="h-5 w-5 accent-brand-700" checked={params.filters.overdue === '1'} onChange={(e) => params.setFilter('overdue', e.target.checked ? '1' : null)} />Overdue only</label>
      </div>
      <DataTable caption="Orders waiting for the courier’s payout" columns={columns} query={query} params={params} getRowId={(r) => String(r.orderId)} emptyMessage={params.hasFilters ? 'No order matches.' : 'Every delivered COD order has been paid out.'} />
    </section>
  );
}

function Payouts() {
  const { api } = useAuth();
  const params = useTableParams({ sort: 'newest', filterKeys: [] });
  const query = useQuery({ queryKey: ['cod-remittances', params.page], queryFn: () => api.request<Page<CodRemittanceRow>>('GET', '/admin/cod-remittances', { query: { page: params.page, limit: 25 } }), placeholderData: (prev) => prev });
  const columns: ColumnDef<CodRemittanceRow, unknown>[] = [
    { id: 'payout', header: 'Payout', cell: ({ row: { original: r } }) => <div><div className="font-medium text-ink-900">{r.courierName} · <span className="font-mono">{r.reference}</span></div><div className="text-sm text-ink-700">{when(r.remittedAt)}{r.recordedBy ? ` · recorded by ${r.recordedBy}` : ''}</div>{r.note && <div className="text-sm text-ink-700">{r.note}</div>}</div> },
    { id: 'amount', header: 'Amount', cell: ({ row: { original: r } }) => <span className="tabular-nums font-medium">{formatINR(r.amount)}</span> },
    { id: 'orders', header: 'Orders', cell: ({ row: { original: r } }) => (
      <ul className="text-sm">{r.orders.map((o) => <li key={o.orderId}><Link to={`/orders/${o.orderId}`} className="font-mono text-brand-700 underline-offset-2 hover:underline">{o.orderNumber}</Link> <span className="tabular-nums">{formatINR(o.amount)}</span>
        {o.amount !== o.expected && <span className="text-danger-700"> (order total {formatINR(o.expected)})</span>}</li>)}</ul>
    ) },
  ];
  return (
    <section aria-labelledby="payouts-h" className="space-y-3">
      <h2 id="payouts-h" className="sr-only">Payouts</h2>
      <DataTable caption="Courier payouts" columns={columns} query={query} params={params} getRowId={(r) => String(r.id)} emptyMessage="No payout recorded yet." />
    </section>
  );
}

type RecordForm = { courierName: string; reference: string; remittedAt: string; amount: string; note: string; lines: { orderNumber: string; picked: boolean; amount: string }[] };
const recordForm = convertedForm<RecordForm, typeof codRemittanceBody>(
  (v) => rupeeProblems(([[['amount'], v.amount], ...v.lines.map((l, n) => [['lines', n, 'amount'], l.amount])] as [(string | number)[], string][]).filter(([p]) => p[0] === 'amount' || v.lines[p[1] as number]?.picked)),
  (v) => ({
    courierName: v.courierName, reference: v.reference, remittedAt: v.remittedAt, note: v.note,
    amount: v.amount.trim() ? toPaise(v.amount) : Number.NaN,
    orders: v.lines.filter((l) => l.picked).map((l) => ({ orderNumber: l.orderNumber, amount: l.amount.trim() ? toPaise(l.amount) : Number.NaN })),
  }),
  codRemittanceBody,
);

function RecordDialog({ onClose }: { onClose: () => void }) {
  const { api } = useAuth();
  const qc = useQueryClient();
  const waiting = useQuery({ queryKey: ['cod-outstanding', 'all'], queryFn: () => api.request<Outstanding>('GET', '/admin/cod/outstanding', { query: { limit: 500 } }) });
  return (
    <FormDialog open onOpenChange={(v) => { if (!v) onClose(); }} title="Record a courier payout" description="Tick the orders this payout covers and enter what the courier paid for each. Orders paid a different amount than their total are flagged for follow-up.">
      {waiting.isPending ? <p role="status" className="text-ink-700">Loading orders waiting for cash…</p>
        : waiting.isError ? <FormAlert>{errorMessage(waiting.error)}</FormAlert>
        : waiting.data.data.length === 0 ? <FormAlert>No delivered cash-on-delivery order is waiting for a payout.</FormAlert>
        : <RecordFormView rows={waiting.data.data} onClose={onClose} onDone={() => { void qc.invalidateQueries({ queryKey: ['cod-outstanding'] }); void qc.invalidateQueries({ queryKey: ['cod-remittances'] }); }} />}
    </FormDialog>
  );
}

function RecordFormView({ rows, onClose, onDone }: { rows: CodOutstandingRow[]; onClose: () => void; onDone: () => void }) {
  const { api } = useAuth();
  const [problem, setProblem] = useState<string | null>(null);
  const { register, handleSubmit, setError, control, formState: { errors, isSubmitting } } = useForm<RecordForm, unknown, ReturnType<typeof recordForm.parse>>({
    resolver: zodResolver(recordForm),
    defaultValues: { courierName: rows[0]?.courierName ?? '', reference: '', remittedAt: today(), amount: '', note: '', lines: rows.map((r) => ({ orderNumber: r.orderNumber, picked: false, amount: fromPaise(r.total) })) },
  });
  const v = useWatch({ control }) as RecordForm;
  const picked = v.lines.map((l, n) => (l.picked ? n : -1)).filter((n) => n >= 0);
  const sum = picked.reduce((s, n) => s + (/^\d+(\.\d{1,2})?$/.test(v.lines[n]!.amount.trim()) ? toPaise(v.lines[n]!.amount) : 0), 0);
  // Issues for orders.<i> (the ticked ones, in order) belong to the form line picked[i].
  const lineErrors = (errors as unknown as { orders?: { orderNumber?: { message?: string }; amount?: { message?: string } }[] }).orders ?? [];
  const lineError = (n: number, k: 'orderNumber' | 'amount') => { const i = picked.indexOf(n); return i >= 0 ? lineErrors[i]?.[k]?.message ?? (k === 'amount' ? errors.lines?.[n]?.amount?.message : undefined) : undefined; };
  const ordersError = (errors as unknown as { orders?: { message?: string; root?: { message?: string } } }).orders;
  const save = handleSubmit(async (body) => {
    setProblem(null);
    try {
      const r = await api.request<CodRemittanceResult>('POST', '/admin/cod-remittances', { body });
      if (r.mismatches.length) toast.warning(`Payout recorded. ${r.mismatches.length} order${r.mismatches.length === 1 ? ' was' : 's were'} paid a different amount and flagged: ${r.mismatches.map((m) => m.orderNumber).join(', ')}`);
      else toast.success(`Payout ${r.remittance.reference} recorded for ${r.remittance.orders.length} order${r.remittance.orders.length === 1 ? '' : 's'}`);
      onDone(); onClose();
    } catch (e) {
      if (applyServerErrors(e, setError, ['courierName', 'reference', 'remittedAt', 'amount', 'note', ...body.orders.flatMap((_, i) => [`orders.${i}.orderNumber`, `orders.${i}.amount`] as never[])])) return;
      setProblem(errorMessage(e));
      if (e instanceof ApiError && e.code === 'CONFLICT') onDone();
    }
  });
  return (
    <form noValidate onSubmit={(e) => { void save(e); }} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id="cr-courier" label="Courier" {...register('courierName')} error={errors.courierName?.message} />
        <TextField id="cr-ref" label="Payout reference (UTR)" autoComplete="off" {...register('reference')} error={errors.reference?.message} />
        <TextField id="cr-date" label="Paid on" type="date" {...register('remittedAt')} error={errors.remittedAt?.message} />
        <TextField id="cr-amount" label="Amount paid (₹)" inputMode="decimal" placeholder={sum ? fromPaise(sum) : ''} {...register('amount')} error={errors.amount?.message} />
      </div>
      <fieldset className="max-h-72 space-y-2 overflow-y-auto rounded-md border border-surface-200 p-3">
        <legend className="px-1 text-sm font-medium text-ink-900">Orders in this payout</legend>
        {rows.map((r, n) => (
          <div key={r.orderId} className="grid grid-cols-[auto_1fr_8rem] items-start gap-3 text-sm">
            <input id={`cr-pick-${n}`} type="checkbox" className="mt-3 h-5 w-5 accent-brand-700" {...register(`lines.${n}.picked`)} />
            <label htmlFor={`cr-pick-${n}`} className="pt-2"><span className="font-mono">{r.orderNumber}</span> <span className="text-ink-700">· {r.courierName ?? '—'} · {formatINR(r.total)} · {r.days} days</span>
              {lineError(n, 'orderNumber') && <span className="block text-danger-700">{lineError(n, 'orderNumber')}</span>}</label>
            <TextField id={`cr-amt-${n}`} label={`Paid for ${r.orderNumber}`} className="[&>label]:sr-only" inputMode="decimal" {...register(`lines.${n}.amount`)} error={lineError(n, 'amount')} />
          </div>
        ))}
      </fieldset>
      {ordersError?.message || ordersError?.root?.message ? <p className="text-sm text-danger-700">{ordersError.message ?? ordersError.root?.message}</p> : null}
      <p className="text-sm text-ink-900">{picked.length} order{picked.length === 1 ? '' : 's'} ticked, adding up to <strong className="tabular-nums">{formatINR(sum)}</strong>.</p>
      <TextField id="cr-note" label="Note (optional)" {...register('note')} error={errors.note?.message} />
      {problem && <FormAlert>{problem}</FormAlert>}
      <div className="flex justify-end gap-3 pt-1">
        <button type="button" className={quiet} onClick={onClose}>Cancel</button>
        <button type="submit" className={primary} disabled={isSubmitting}>{isSubmitting ? 'Recording…' : 'Record payout'}</button>
      </div>
    </form>
  );
}
