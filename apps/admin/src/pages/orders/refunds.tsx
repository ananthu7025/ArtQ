// Refunds in the admin (task 5.4; product.md §7.5 "Returns & Refunds", architecture.md §10.2) [refunds:create].
// RefundDialog: what is still refundable per item, shipping and COD fee (pending refunds count), entered in rupees and
// checked by the shared refundCreateBody; one Idempotency-Key per dialog; the password re-check is asked for by the
// API client when needed. OrderRefunds: an order's refunds with Retry (failed online), Record bank transfer and Cancel
// (COD refunds not yet paid). Capacity refusals explain themselves and reload what is left.
import { formatINR, refundCreateBody, manualRefundBody, type AdminRefundRow, type RefundableView, type RefundStatusValue } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { ApiError, type Page } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { btn, FormDialog } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { applyServerErrors, FormAlert, SelectField, TextField } from '../../components/form';
import { convertedForm, fromPaise, rupeeProblems, toPaise, wholeProblems } from '../../components/form-schema';
import { when } from './labels';

const primary = `${btn} bg-brand-700 text-white disabled:opacity-80`;
const outline = `${btn} border border-border-input bg-white`;
const quiet = `${btn} text-ink-900 hover:bg-surface-100`;

export const REFUND_STATUS: Record<RefundStatusValue, [string, string]> = {
  REQUESTED: ['Requested', 'bg-warning-bg text-warning-ink'], PENDING: ['With the bank', 'bg-[#e0f2fe] text-[#075985]'], PROCESSED: ['Refunded', 'bg-[#dcfce7] text-success-700'],
  FAILED: ['Failed', 'bg-[#fee2e2] text-danger-700'], UNKNOWN: ['Checking with Razorpay', 'bg-warning-bg text-warning-ink'], CANCELLED: ['Cancelled', 'bg-surface-100 text-ink-700'],
};
export const KIND_LABEL: Record<string, string> = { CANCELLATION: 'Cancellation', RETURN: 'Return', GOODWILL: 'Goodwill', PRICE_ADJUSTMENT: 'Price adjustment', EXCESS_CAPTURE: 'Paid twice', LATE_CAPTURE: 'Paid too late', PROVIDER_INITIATED: 'Made in Razorpay' };
export const RefundPill = ({ status }: { status: RefundStatusValue }) => <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${REFUND_STATUS[status][1]}`}>{REFUND_STATUS[status][0]}</span>;

type RefundForm = { kind: 'GOODWILL' | 'PRICE_ADJUSTMENT'; reason: string; shippingAmount: string; codFeeAmount: string; items: { orderItemId: number; quantity: string; amount: string }[] };
const refundForm = convertedForm<RefundForm, typeof refundCreateBody>(
  (v) => [
    ...rupeeProblems(([[['shippingAmount'], v.shippingAmount], [['codFeeAmount'], v.codFeeAmount], ...v.items.map((i, n) => [['items', n, 'amount'], i.amount])] as [(string | number)[], string][]).filter(([, s]) => s.trim() !== '')),
    ...wholeProblems(v.items.map((i, n): [(string | number)[], string] => [['items', n, 'quantity'], i.quantity]).filter(([, s]) => s.trim() !== ''), 'Use whole units'),
  ],
  (v) => ({
    kind: v.kind, reason: v.reason, shippingAmount: v.shippingAmount.trim() ? toPaise(v.shippingAmount) : 0, codFeeAmount: v.codFeeAmount.trim() ? toPaise(v.codFeeAmount) : 0,
    items: v.items.filter((i) => i.amount.trim() !== '' && toPaise(i.amount) > 0).map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity.trim() ? Number(i.quantity) : 0, amount: toPaise(i.amount) })),
  }),
  refundCreateBody,
);

export function RefundDialog({ orderId, onClose, onDone }: { orderId: number; onClose: () => void; onDone: () => void }) {
  const { api } = useAuth();
  const q = useQuery({ queryKey: ['refundable', orderId], queryFn: () => api.request<RefundableView>('GET', `/admin/orders/${orderId}/refundable`) });
  return (
    <FormDialog open onOpenChange={(v) => { if (!v) onClose(); }} title="Refund" description="Pending refunds already count against what is left. Online refunds go back to the customer’s payment; COD refunds are paid by bank or UPI transfer.">
      {q.isPending ? <p role="status" className="text-ink-700">Loading what can be refunded…</p>
        : q.isError ? <FormAlert>{errorMessage(q.error)}</FormAlert>
        : q.data.method === null ? <FormAlert>{q.data.blockedReason}</FormAlert>
        : <RefundFormView view={q.data} onClose={onClose} onDone={onDone} reload={() => void q.refetch()} />}
    </FormDialog>
  );
}

function RefundFormView({ view, onClose, onDone, reload }: { view: RefundableView; onClose: () => void; onDone: () => void; reload: () => void }) {
  const { api } = useAuth();
  const [key] = useState(() => crypto.randomUUID());
  const [problem, setProblem] = useState<string | null>(null);
  const { register, handleSubmit, setError, control, formState: { errors, isSubmitting } } = useForm<RefundForm, unknown, ReturnType<typeof refundForm.parse>>({
    resolver: zodResolver(refundForm),
    defaultValues: { kind: 'GOODWILL', reason: '', shippingAmount: '', codFeeAmount: '', items: view.items.map((i) => ({ orderItemId: i.orderItemId, quantity: '', amount: '' })) },
  });
  const v = useWatch({ control }) as RefundForm;
  const total = [...v.items.map((i) => i.amount), v.shippingAmount, v.codFeeAmount].reduce((s, a) => s + (/^\d+(\.\d{1,2})?$/.test(a.trim()) ? toPaise(a) : 0), 0);
  const save = handleSubmit(async (body) => {
    setProblem(null);
    try {
      const r = await api.request<{ refundId: number; method: string }>('POST', `/admin/orders/${view.orderId}/refunds`, { body, headers: { 'Idempotency-Key': key } });
      toast.success(r.method === 'MANUAL_BANK' ? `Refund #${r.refundId} recorded. Transfer ${formatINR(total)} and then mark it paid.` : `Refund #${r.refundId} of ${formatINR(total)} sent to Razorpay`);
      onDone(); onClose();
    } catch (e) {
      // The form shows items by position in the order; the body only carries the ones being refunded.
      if (e instanceof ApiError && Array.isArray(e.details)) {
        const sentIds = body.items.map((i) => i.orderItemId);
        for (const d of e.details as { path?: string }[]) {
          const m = /^items\.(\d+)\.(\w+)$/.exec(d.path ?? '');
          if (m) d.path = `items.${view.items.findIndex((i) => i.orderItemId === sentIds[Number(m[1])])}.${m[2]}`;
        }
      }
      if (applyServerErrors(e, setError, ['kind', 'reason', 'shippingAmount', 'codFeeAmount', ...view.items.flatMap((_, n) => [`items.${n}.quantity`, `items.${n}.amount`] as const)])) return;
      if (e instanceof ApiError && e.code === 'REFUND_EXCEEDS_CAPACITY') reload();
      setProblem(errorMessage(e));
    }
  });
  const rootError = (errors as { ''?: { message?: string }; root?: { message?: string } })[''] ?? errors.root;
  return (
    <form noValidate onSubmit={(e) => { void save(e); }} className="space-y-4">
      {view.payment?.reconciliationRequired && <FormAlert>Razorpay shows refunds on this payment that ArtQ hasn’t recorded yet. New refunds wait until they are reconciled (a few minutes).</FormAlert>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Refund per item</caption>
          <thead><tr className="text-left text-ink-700"><th scope="col" className="py-1 font-medium">Item</th><th scope="col" className="py-1 font-medium">Left to refund</th><th scope="col" className="py-1 font-medium">Units back</th><th scope="col" className="py-1 font-medium">Amount (₹)</th></tr></thead>
          <tbody>
            {view.items.map((i, n) => (
              <tr key={i.orderItemId} className="align-top">
                <td className="py-1 pr-2"><div className="font-medium text-ink-900">{i.name}</div><div className="text-ink-700">{i.label} · {i.quantity} bought</div></td>
                <td className="py-1 pr-2 tabular-nums">{formatINR(i.availableAmount)}<div className="text-xs text-ink-700">{i.availableQty} unit{i.availableQty === 1 ? '' : 's'}</div></td>
                <td className="py-1 pr-2"><TextField id={`r-q-${n}`} label={`Units back: ${i.name}`} className="[&>label]:sr-only" inputMode="numeric" {...register(`items.${n}.quantity`)} error={errors.items?.[n]?.quantity?.message} /></td>
                <td className="py-1"><TextField id={`r-a-${n}`} label={`Amount: ${i.name}`} className="[&>label]:sr-only" inputMode="decimal" placeholder={fromPaise(i.availableAmount)} {...register(`items.${n}.amount`)} error={errors.items?.[n]?.amount?.message} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {view.shipping.fee > 0 && <TextField id="r-ship" label={`Shipping (₹, up to ${fromPaise(view.shipping.available)})`} inputMode="decimal" {...register('shippingAmount')} error={errors.shippingAmount?.message} />}
        {view.codFee.fee > 0 && <TextField id="r-cod" label={`COD fee (₹, up to ${fromPaise(view.codFee.available)})`} inputMode="decimal" {...register('codFeeAmount')} error={errors.codFeeAmount?.message} />}
        <SelectField id="r-kind" label="Kind" {...register('kind')} error={errors.kind?.message}><option value="GOODWILL">Goodwill</option><option value="PRICE_ADJUSTMENT">Price adjustment</option></SelectField>
      </div>
      <TextField id="r-reason" label="Reason (kept on the refund)" {...register('reason')} error={errors.reason?.message} />
      <p className="text-sm text-ink-900">Refund total: <strong className="tabular-nums">{formatINR(total)}</strong> of {formatINR(view.total.available)} left on the order{view.payment ? ` (${formatINR(view.payment.available)} on the payment)` : ''}.</p>
      {rootError?.message && <FormAlert>{rootError.message}</FormAlert>}
      {problem && <FormAlert>{problem}</FormAlert>}
      <div className="flex justify-end gap-3 pt-1">
        <button type="button" className={quiet} onClick={onClose}>Cancel</button>
        <button type="submit" className={primary} disabled={isSubmitting}>{isSubmitting ? 'Refunding…' : `Refund ${formatINR(total)}`}</button>
      </div>
    </form>
  );
}

export function OrderRefunds({ orderId, onChanged }: { orderId: number; onChanged: () => void }) {
  const { api, can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['order-refunds', orderId], queryFn: () => api.request<Page<AdminRefundRow>>('GET', '/admin/refunds', { query: { orderId, limit: 100 } }), enabled: can('refunds:create') });
  const [paying, setPaying] = useState<AdminRefundRow | null>(null);
  if (!can('refunds:create') || !q.data || q.data.data.length === 0) return null;
  const changed = () => { void qc.invalidateQueries({ queryKey: ['order-refunds', orderId] }); onChanged(); };
  const run = async (r: AdminRefundRow, what: 'retry' | 'cancel') => {
    try { await api.request('POST', `/admin/refunds/${r.id}/${what}`); toast.success(what === 'retry' ? `Refund #${r.id} sent again` : `Refund #${r.id} cancelled`); changed(); }
    catch (e) { toast.error(errorMessage(e)); changed(); }
  };
  return (
    <section aria-labelledby="refunds-h" className="rounded-lg border border-surface-200 bg-white p-5">
      <h2 id="refunds-h" className="mb-3 font-semibold text-ink-900">Refunds</h2>
      <ul className="divide-y divide-surface-100 text-sm">
        {q.data.data.map((r) => (
          <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 py-2">
            <div>
              <div className="flex flex-wrap items-center gap-2"><span className="font-medium">#{r.id} {KIND_LABEL[r.kind] ?? r.kind}</span><RefundPill status={r.status} /></div>
              <div className="text-ink-700">{r.method === 'MANUAL_BANK' ? 'Bank / UPI transfer' : 'To the online payment'} · {when(r.createdAt)}{r.reason ? ` · ${r.reason}` : ''}</div>
              {r.failureReason && <div className="text-danger-700">{r.failureReason}</div>}
              {r.manualReference && <div className="text-ink-700">Reference {r.manualReference}</div>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="tabular-nums font-medium">{formatINR(r.amount)}</span>
              {r.actions.includes('retry') && <button type="button" className={outline} onClick={() => void run(r, 'retry')}>Retry</button>}
              {r.actions.includes('manual-processed') && <button type="button" className={outline} onClick={() => setPaying(r)}>Record transfer</button>}
              {r.actions.includes('cancel') && <button type="button" className={`${btn} text-danger-700 hover:bg-[#fee2e2]`} aria-label={`Cancel refund #${r.id}`} onClick={() => void run(r, 'cancel')}>Cancel</button>}
            </div>
          </li>
        ))}
      </ul>
      {paying && <ManualDialog refund={paying} onClose={() => setPaying(null)} onDone={changed} />}
    </section>
  );
}

function ManualDialog({ refund, onClose, onDone }: { refund: AdminRefundRow; onClose: () => void; onDone: () => void }) {
  const { api } = useAuth();
  const [problem, setProblem] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<{ manualReference: string }>({ resolver: zodResolver(manualRefundBody), defaultValues: { manualReference: '' } });
  const save = handleSubmit(async (body) => {
    setProblem(null);
    try { await api.request('POST', `/admin/refunds/${refund.id}/manual-processed`, { body }); toast.success(`Refund #${refund.id} marked paid`); onDone(); onClose(); }
    catch (e) { if (!applyServerErrors(e, setError, ['manualReference'])) setProblem(errorMessage(e)); }
  });
  return (
    <FormDialog open onOpenChange={(v) => { if (!v) onClose(); }} title={`Record the transfer for refund #${refund.id}`} description={`Transfer ${formatINR(refund.amount)} to the customer first, then enter the bank or UPI reference. This marks the refund paid.`}>
      <form noValidate onSubmit={(e) => { void save(e); }} className="space-y-3">
        <TextField id="m-ref" label="Bank / UPI reference" autoComplete="off" {...register('manualReference')} error={errors.manualReference?.message} />
        {problem && <FormAlert>{problem}</FormAlert>}
        <div className="flex justify-end gap-3"><button type="button" className={quiet} onClick={onClose}>Cancel</button><button type="submit" className={primary} disabled={isSubmitting}>{isSubmitting ? 'Saving…' : 'Mark paid'}</button></div>
      </form>
    </FormDialog>
  );
}
