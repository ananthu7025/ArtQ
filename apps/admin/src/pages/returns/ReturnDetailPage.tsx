// A return request (task 5.5; product.md §7.5 "Returns & Refunds", database.md §8.5b) [returns:receive]: what the
// customer asked for and why, their photos, the units at each step (requested → approved → received → sellable /
// damaged → refunded), and the next step as buttons: Decide, Close and Cancel [returns:decide]; On its way back,
// Receive and Inspect [returns:receive]; Refund [refunds:create, password re-check]. Every form uses the shared schema;
// the server's refusals land on their field, and a step someone else already took reloads the return.
import {
  formatINR, returnCancelBody, returnDecideBody, returnInspectBody, returnReceiveBody, returnRefundBody, type AdminReturnDetail, type Permission, type ReturnAction,
} from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { useForm, useWatch, type UseFormRegisterReturn } from 'react-hook-form';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { btn, FormDialog } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { applyServerErrors, FormAlert, TextField } from '../../components/form';
import { convertedForm, fromPaise, rupeeProblems, toPaise, wholeProblems } from '../../components/form-schema';
import { NotFoundPage } from '../simple';
import { when } from '../orders/labels';
import { RefundPill } from '../orders/refunds';
import { reasonLabel, ReturnPill } from './labels';

const card = 'rounded-lg border border-surface-200 bg-white p-5';
const primary = `${btn} bg-brand-700 text-white disabled:opacity-80`;
const outline = `${btn} border border-border-input bg-white`;
const quiet = `${btn} text-ink-900 hover:bg-surface-100`;
const h2 = 'mb-3 font-semibold text-ink-900';
const PERM: Record<ReturnAction, Permission> = { decide: 'returns:decide', close: 'returns:decide', cancel: 'returns:decide', 'in-transit': 'returns:receive', receive: 'returns:receive', inspect: 'returns:receive', refund: 'refunds:create' };
const whole = (s: string) => (s.trim() === '' ? Number.NaN : Number(s));

export function ReturnDetailPage() {
  const id = Number(useParams().id);
  const { api, can } = useAuth();
  const qc = useQueryClient();
  const key = ['return', id];
  const q = useQuery({ queryKey: key, queryFn: () => api.request<AdminReturnDetail>('GET', `/admin/returns/${id}`), enabled: Number.isSafeInteger(id) && id > 0, retry: false });
  const [open, setOpen] = useState<ReturnAction | null>(null);
  if (!Number.isSafeInteger(id) || id <= 0 || (q.error instanceof ApiError && q.error.status === 404)) return <NotFoundPage />;
  if (q.isPending) return <p role="status" className="text-ink-700">Loading the return…</p>;
  if (q.isError) return <FormAlert>Couldn’t load this return. <button type="button" className="underline" onClick={() => void q.refetch()}>Retry</button></FormAlert>;
  const r = q.data;
  const set = (d: AdminReturnDetail) => { qc.setQueryData(key, d); void qc.invalidateQueries({ queryKey: ['returns'] }); void qc.invalidateQueries({ queryKey: ['order', r.orderId] }); };
  /** A refusal because the return moved on: say so and show the latest. */
  const refused = (e: unknown) => { toast.error(errorMessage(e)); void q.refetch(); };
  const allowed = r.actions.filter((a) => can(PERM[a]));
  const label: Record<ReturnAction, string> = { decide: 'Approve or reject', 'in-transit': 'On its way back', receive: 'Receive', inspect: 'Inspect', refund: 'Refund', close: 'Close', cancel: 'Cancel return' };
  const close = () => setOpen(null);
  return (
    <div className="space-y-5">
      <Link to="/returns" className="inline-flex items-center gap-1 text-sm font-medium text-brand-700"><ArrowLeft size={16} aria-hidden />All returns</Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink-900">Return #{r.id}</h1>
          <p className="mt-1 text-sm text-ink-700">Order <Link to={`/orders/${r.orderId}`} className="font-mono text-brand-700 underline-offset-2 hover:underline">{r.orderNumber}</Link> · {r.customerName} · asked {when(r.createdAt)}{r.deliveredAt ? ` · delivered ${when(r.deliveredAt)}` : ''}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2"><ReturnPill status={r.status} /><span className="text-sm font-medium text-ink-900">{reasonLabel(r.reason)}</span></div>
        </div>
        <div className="flex flex-wrap gap-2">
          {allowed.map((a) => <button key={a} type="button" className={a === 'cancel' ? `${btn} border border-danger-700 bg-white text-danger-700 hover:bg-[#fee2e2]` : a === allowed[0] ? primary : outline} onClick={() => setOpen(a)}>{label[a]}</button>)}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Items r={r} />
          <section aria-labelledby="photos-h" className={card}>
            <h2 id="photos-h" className={h2}>Customer’s photos</h2>
            {r.photos.length === 0 ? <p className="text-sm text-ink-700">{r.reason === 'MISSING_ITEM' ? 'None needed for a missing item.' : 'No photos.'}</p> : (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {r.photos.map((p, n) => <li key={p.id}><a href={p.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border border-surface-200">
                  <img src={p.thumbUrl ?? p.url} alt={`Customer photo ${n + 1}`} className="aspect-square w-full object-cover" /></a></li>)}
              </ul>
            )}
            {r.photos.length > 0 && <p className="mt-2 text-xs text-ink-700">Links work for 5 minutes; reload the page for fresh ones.</p>}
          </section>
        </div>
        <div className="space-y-5">
          <section aria-labelledby="what-h" className={card}>
            <h2 id="what-h" className={h2}>What happened</h2>
            <p className="text-sm text-ink-900">{r.description ?? 'The customer added no description.'}</p>
            {r.adminNote && <p className="mt-3 rounded-md bg-surface-100 p-3 text-sm"><span className="font-medium">Staff note:</span> {r.adminNote}</p>}
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {r.decidedAt && <><dt className="text-ink-700">Decided</dt><dd>{when(r.decidedAt)}{r.decidedBy ? ` by ${r.decidedBy}` : ''}</dd></>}
              {r.receivedAt && <><dt className="text-ink-700">Received</dt><dd>{when(r.receivedAt)}</dd></>}
              {r.inspectedAt && <><dt className="text-ink-700">Inspected</dt><dd>{when(r.inspectedAt)}</dd></>}
              {r.closedAt && <><dt className="text-ink-700">{r.status === 'CANCELLED' ? 'Cancelled' : 'Closed'}</dt><dd>{when(r.closedAt)}</dd></>}
            </dl>
          </section>
          {r.refunds.length > 0 && (
            <section aria-labelledby="rrf-h" className={card}>
              <h2 id="rrf-h" className={h2}>Refunds</h2>
              <ul className="space-y-2 text-sm">{r.refunds.map((f) => <li key={f.id} className="flex flex-wrap items-center justify-between gap-2"><span>#{f.id} <RefundPill status={f.status as never} /></span><span className="tabular-nums font-medium">{formatINR(f.amount)}</span></li>)}</ul>
              <p className="mt-2 text-xs text-ink-700">Retry a failed refund from the order page.</p>
            </section>
          )}
        </div>
      </div>

      {open === 'decide' && <DecideDialog r={r} onClose={close} onDone={set} onRefused={refused} />}
      {open === 'receive' && <ReceiveDialog r={r} onClose={close} onDone={set} onRefused={refused} />}
      {open === 'inspect' && <InspectDialog r={r} onClose={close} onDone={set} onRefused={refused} />}
      {open === 'refund' && <ReturnRefundDialog r={r} onClose={close} onDone={() => void q.refetch()} onRefused={refused} />}
      {open === 'cancel' && <CancelReturnDialog r={r} onClose={close} onDone={set} onRefused={refused} />}
      {(open === 'in-transit' || open === 'close') && <StepDialog r={r} step={open} onClose={close} onDone={set} onRefused={refused} />}
    </div>
  );
}

function Items({ r }: { r: AdminReturnDetail }) {
  const n = (v: number | null) => (v === null ? '—' : v);
  return (
    <section aria-labelledby="ritems-h" className={card}>
      <h2 id="ritems-h" className={h2}>Items</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Units at each step</caption>
          <thead><tr className="border-b border-surface-200 text-left text-ink-700">
            <th scope="col" className="py-2 font-medium">Item</th><th scope="col" className="py-2 text-right font-medium">Asked</th><th scope="col" className="py-2 text-right font-medium">Approved</th>
            <th scope="col" className="py-2 text-right font-medium">Received</th><th scope="col" className="py-2 text-right font-medium">Sellable / damaged</th><th scope="col" className="py-2 text-right font-medium">Refunded</th>
          </tr></thead>
          <tbody>{r.items.map((i) => (
            <tr key={i.orderItemId} className="border-b border-surface-100 align-top">
              <td className="py-2 pr-3"><div className="font-medium text-ink-900">{i.name}</div><div className="text-ink-700">{i.label} · {i.bought} bought · {formatINR(i.netAmount)}</div></td>
              <td className="py-2 text-right tabular-nums">{i.requestedQty}</td><td className="py-2 text-right tabular-nums">{n(i.approvedQty)}</td><td className="py-2 text-right tabular-nums">{n(i.receivedQty)}</td>
              <td className="py-2 text-right tabular-nums">{i.sellableQty === null ? '—' : `${i.sellableQty} / ${i.damagedQty}`}</td><td className="py-2 text-right tabular-nums">{i.refundedQty}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}

type Props = { r: AdminReturnDetail; onClose: () => void; onDone: (d: AdminReturnDetail) => void; onRefused: (e: unknown) => void };
const Buttons = ({ onClose, busy, label, busyLabel, danger }: { onClose: () => void; busy: boolean; label: string; busyLabel: string; danger?: boolean }) => (
  <div className="flex justify-end gap-3 pt-1"><button type="button" className={quiet} onClick={onClose}>Back</button>
    <button type="submit" className={danger ? `${btn} bg-danger-700 text-white disabled:opacity-80` : primary} disabled={busy}>{busy ? busyLabel : label}</button></div>
);
const NoteField = ({ id, label, error, ...reg }: { id: string; label: string; error?: string | undefined } & UseFormRegisterReturn) => (
  <div>
    <label htmlFor={id} className="block text-sm font-medium text-ink-900">{label}</label>
    <textarea id={id} rows={3} className="mt-1 block w-full rounded-md border border-border-input p-2 text-sm" aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} {...reg} />
    {error && <p id={`${id}-error`} className="mt-1 text-sm text-danger-700">{error}</p>}
  </div>
);
/** A refusal that belongs to no field: the step moved on (reload), or say it in the form. */
function fail(e: unknown, onRefused: (e: unknown) => void, onClose: () => void, setProblem: (s: string) => void) {
  if (e instanceof ApiError && ['INVALID_TRANSITION', 'NOT_FOUND'].includes(e.code)) { onRefused(e); onClose(); return; }
  setProblem(errorMessage(e));
}

type DecideForm = { decision: 'APPROVE' | 'REJECT'; note: string; items: { orderItemId: number; approvedQty: string }[] };
const decideForm = convertedForm<DecideForm, typeof returnDecideBody>(
  (v) => (v.decision === 'APPROVE' ? wholeProblems(v.items.map((i, n): [(string | number)[], string] => [['items', n, 'approvedQty'], i.approvedQty]), 'Use whole units') : []),
  (v) => ({ decision: v.decision, note: v.note, items: v.decision === 'APPROVE' ? v.items.map((i) => ({ orderItemId: i.orderItemId, approvedQty: whole(i.approvedQty) })) : [] }),
  returnDecideBody,
);

function DecideDialog({ r, onClose, onDone, onRefused }: Props) {
  const { api } = useAuth();
  const [problem, setProblem] = useState<string | null>(null);
  const { register, handleSubmit, setError, control, formState: { errors, isSubmitting } } = useForm<DecideForm, unknown, ReturnType<typeof decideForm.parse>>({
    resolver: zodResolver(decideForm), defaultValues: { decision: 'APPROVE', note: '', items: r.items.map((i) => ({ orderItemId: i.orderItemId, approvedQty: String(i.requestedQty) })) },
  });
  const decision = useWatch({ control, name: 'decision' });
  const save = handleSubmit(async (body) => {
    setProblem(null);
    try { onDone(await api.request<AdminReturnDetail>('POST', `/admin/returns/${r.id}/decide`, { body })); toast.success(body.decision === 'APPROVE' ? `Return #${r.id} approved; the customer is emailed` : `Return #${r.id} rejected; the customer is emailed`); onClose(); }
    catch (e) { if (!applyServerErrors(e, setError, ['note', 'items', ...r.items.map((_, n) => `items.${n}.approvedQty` as const)])) fail(e, onRefused, onClose, setProblem); }
  });
  // An issue on the whole list lands on `items.root` (RHF field-array errors) or, from the server, on `items`.
  const itemsError = (errors.items as { message?: string; root?: { message?: string } } | undefined)?.root?.message ?? (errors.items as { message?: string } | undefined)?.message;
  return (
    <FormDialog open onOpenChange={(v) => { if (!v) onClose(); }} title={`Decide return #${r.id}`} description="Approve the units you accept (the rest are released), or reject it with a reason. The customer is emailed either way.">
      <form noValidate onSubmit={(e) => { void save(e); }} className="space-y-4">
        <fieldset className="flex gap-6 text-sm">
          <legend className="sr-only">Decision</legend>
          <label className="flex items-center gap-2"><input type="radio" value="APPROVE" className="h-4 w-4 accent-brand-700" {...register('decision')} />Approve</label>
          <label className="flex items-center gap-2"><input type="radio" value="REJECT" className="h-4 w-4 accent-brand-700" {...register('decision')} />Reject</label>
        </fieldset>
        {decision === 'APPROVE' && r.items.map((i, n) => (
          <TextField key={i.orderItemId} id={`d-q-${n}`} label={`Units to accept: ${i.name} (${i.label}), ${i.requestedQty} asked`} inputMode="numeric" {...register(`items.${n}.approvedQty`)} error={errors.items?.[n]?.approvedQty?.message} />
        ))}
        {itemsError && <p className="text-sm text-danger-700">{itemsError}</p>}
        <NoteField id="d-note" label={decision === 'REJECT' ? 'Why (sent to the customer)' : 'Note for the customer (optional)'} {...register('note')} error={errors.note?.message} />
        {problem && <FormAlert>{problem}</FormAlert>}
        <Buttons onClose={onClose} busy={isSubmitting} label={decision === 'REJECT' ? 'Reject return' : 'Approve return'} busyLabel="Saving…" danger={decision === 'REJECT'} />
      </form>
    </FormDialog>
  );
}

type QtyForm = { items: { orderItemId: number; receivedQty: string }[] };
const receiveForm = convertedForm<QtyForm, typeof returnReceiveBody>(
  (v) => wholeProblems(v.items.map((i, n): [(string | number)[], string] => [['items', n, 'receivedQty'], i.receivedQty]), 'Use whole units'),
  (v) => ({ items: v.items.map((i) => ({ orderItemId: i.orderItemId, receivedQty: whole(i.receivedQty) })) }),
  returnReceiveBody,
);

function ReceiveDialog({ r, onClose, onDone, onRefused }: Props) {
  const { api } = useAuth();
  const rows = r.items.filter((i) => (i.approvedQty ?? 0) > 0);
  const [problem, setProblem] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<QtyForm, unknown, ReturnType<typeof receiveForm.parse>>({
    resolver: zodResolver(receiveForm), defaultValues: { items: rows.map((i) => ({ orderItemId: i.orderItemId, receivedQty: String(i.approvedQty) })) },
  });
  const save = handleSubmit(async (body) => {
    setProblem(null);
    try { onDone(await api.request<AdminReturnDetail>('POST', `/admin/returns/${r.id}/receive`, { body })); toast.success(`Return #${r.id} received; the customer is emailed`); onClose(); }
    catch (e) { if (!applyServerErrors(e, setError, rows.map((_, n) => `items.${n}.receivedQty` as const))) fail(e, onRefused, onClose, setProblem); }
  });
  return (
    <FormDialog open onOpenChange={(v) => { if (!v) onClose(); }} title={`Receive return #${r.id}`} description="Count what actually arrived. You inspect it next.">
      <form noValidate onSubmit={(e) => { void save(e); }} className="space-y-4">
        {rows.map((i, n) => <TextField key={i.orderItemId} id={`rc-q-${n}`} label={`Units that arrived: ${i.name} (${i.label}), ${i.approvedQty} approved`} inputMode="numeric" {...register(`items.${n}.receivedQty`)} error={errors.items?.[n]?.receivedQty?.message} />)}
        {problem && <FormAlert>{problem}</FormAlert>}
        <Buttons onClose={onClose} busy={isSubmitting} label="Mark received" busyLabel="Saving…" />
      </form>
    </FormDialog>
  );
}

type InspectForm = { items: { orderItemId: number; sellableQty: string; damagedQty: string }[] };
const inspectForm = convertedForm<InspectForm, typeof returnInspectBody>(
  (v) => wholeProblems(v.items.flatMap((i, n): [(string | number)[], string][] => [[['items', n, 'sellableQty'], i.sellableQty], [['items', n, 'damagedQty'], i.damagedQty]]), 'Use whole units'),
  (v) => ({ items: v.items.map((i) => ({ orderItemId: i.orderItemId, sellableQty: whole(i.sellableQty), damagedQty: whole(i.damagedQty) })) }),
  returnInspectBody,
);

function InspectDialog({ r, onClose, onDone, onRefused }: Props) {
  const { api } = useAuth();
  const rows = r.items.filter((i) => (i.receivedQty ?? 0) > 0);
  const [problem, setProblem] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<InspectForm, unknown, ReturnType<typeof inspectForm.parse>>({
    resolver: zodResolver(inspectForm), defaultValues: { items: rows.map((i) => ({ orderItemId: i.orderItemId, sellableQty: String(i.receivedQty), damagedQty: '0' })) },
  });
  const save = handleSubmit(async (body) => {
    setProblem(null);
    try { onDone(await api.request<AdminReturnDetail>('POST', `/admin/returns/${r.id}/inspect`, { body })); toast.success(`Return #${r.id} inspected; sellable units are back in stock`); onClose(); }
    catch (e) { if (!applyServerErrors(e, setError, rows.flatMap((_, n) => [`items.${n}.sellableQty`, `items.${n}.damagedQty`] as const))) fail(e, onRefused, onClose, setProblem); }
  });
  return (
    <FormDialog open onOpenChange={(v) => { if (!v) onClose(); }} title={`Inspect return #${r.id}`} description="Sellable units go back into stock now; damaged ones are recorded but not restocked. This can’t be undone.">
      <form noValidate onSubmit={(e) => { void save(e); }} className="space-y-4">
        {rows.length === 0 && <p className="text-sm text-ink-700">Nothing arrived, so there is nothing to restock.</p>}
        {rows.map((i, n) => (
          <fieldset key={i.orderItemId} className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-1 text-sm font-medium text-ink-900">{i.name} ({i.label}): {i.receivedQty} received</legend>
            <TextField id={`in-s-${n}`} label="Sellable" inputMode="numeric" {...register(`items.${n}.sellableQty`)} error={errors.items?.[n]?.sellableQty?.message} />
            <TextField id={`in-d-${n}`} label="Damaged" inputMode="numeric" {...register(`items.${n}.damagedQty`)} error={errors.items?.[n]?.damagedQty?.message} />
          </fieldset>
        ))}
        {problem && <FormAlert>{problem}</FormAlert>}
        <Buttons onClose={onClose} busy={isSubmitting} label="Save inspection" busyLabel="Saving…" />
      </form>
    </FormDialog>
  );
}

type RefundForm = { reason: string; shippingAmount: string; items: { orderItemId: number; quantity: string; amount: string }[] };
const refundForm = convertedForm<RefundForm, typeof returnRefundBody>(
  (v) => [
    ...rupeeProblems(([[['shippingAmount'], v.shippingAmount], ...v.items.map((i, n) => [['items', n, 'amount'], i.amount])] as [(string | number)[], string][])),
    ...wholeProblems(v.items.map((i, n): [(string | number)[], string] => [['items', n, 'quantity'], i.quantity]), 'Use whole units'),
  ],
  (v) => ({
    reason: v.reason, shippingAmount: v.shippingAmount.trim() ? toPaise(v.shippingAmount) : 0,
    items: v.items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity.trim() ? Number(i.quantity) : 0, amount: i.amount.trim() ? toPaise(i.amount) : 0 })),
  }),
  returnRefundBody,
);

function ReturnRefundDialog({ r, onClose, onDone, onRefused }: Omit<Props, 'onDone'> & { onDone: () => void }) {
  const { api } = useAuth();
  const qc = useQueryClient();
  const [key] = useState(() => crypto.randomUUID());
  const [problem, setProblem] = useState<string | null>(null);
  const rows = r.items.filter((i) => i.refundableQty > 0);
  const { register, handleSubmit, setError, control, formState: { errors, isSubmitting } } = useForm<RefundForm, unknown, ReturnType<typeof refundForm.parse>>({
    resolver: zodResolver(refundForm),
    defaultValues: { reason: `Return #${r.id}: ${reasonLabel(r.reason).toLowerCase()}`, shippingAmount: '', items: rows.map((i) => ({ orderItemId: i.orderItemId, quantity: String(i.refundableQty), amount: fromPaise(i.refundableAmount) })) },
  });
  const v = useWatch({ control }) as RefundForm;
  const total = [...v.items.map((i) => i.amount), v.shippingAmount].reduce((s, a) => s + (/^\d+(\.\d{1,2})?$/.test(a.trim()) ? toPaise(a) : 0), 0);
  const save = handleSubmit(async (body) => {
    setProblem(null);
    try {
      const res = await api.request<{ refundId: number; method: string }>('POST', `/admin/returns/${r.id}/refund`, { body, headers: { 'Idempotency-Key': key } });
      toast.success(res.method === 'MANUAL_BANK' ? `Refund #${res.refundId} recorded. Transfer ${formatINR(total)}, then mark it paid on the order.` : `Refund #${res.refundId} of ${formatINR(total)} sent to Razorpay`);
      void qc.invalidateQueries({ queryKey: ['order-refunds', r.orderId] });
      onDone(); onClose();
    } catch (e) {
      if (applyServerErrors(e, setError, ['reason', 'shippingAmount', ...rows.flatMap((_, n) => [`items.${n}.quantity`, `items.${n}.amount`] as const)])) return;
      fail(e, onRefused, onClose, setProblem);
    }
  });
  const rootError = (errors as { ''?: { message?: string }; root?: { message?: string } })[''] ?? errors.root;
  return (
    <FormDialog open onOpenChange={(v2) => { if (!v2) onClose(); }} title={`Refund return #${r.id}`} description={r.paymentMethod === 'COD' ? 'Cash on delivery: you transfer the money by bank or UPI, then record it on the order.' : 'Goes back to the customer’s online payment.'}>
      <form noValidate onSubmit={(e) => { void save(e); }} className="space-y-4">
        {rows.map((i, n) => (
          <fieldset key={i.orderItemId} className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-1 text-sm font-medium text-ink-900">{i.name} ({i.label}): up to {i.refundableQty} unit{i.refundableQty === 1 ? '' : 's'}, {formatINR(i.refundableAmount)}</legend>
            <TextField id={`rr-q-${n}`} label="Units" inputMode="numeric" {...register(`items.${n}.quantity`)} error={errors.items?.[n]?.quantity?.message} />
            <TextField id={`rr-a-${n}`} label="Amount (₹)" inputMode="decimal" {...register(`items.${n}.amount`)} error={errors.items?.[n]?.amount?.message} />
          </fieldset>
        ))}
        {r.shippingAvailable > 0 && <TextField id="rr-ship" label={`Shipping (₹, our fault only; up to ${fromPaise(r.shippingAvailable)})`} inputMode="decimal" {...register('shippingAmount')} error={errors.shippingAmount?.message} />}
        <TextField id="rr-reason" label="Reason (kept on the refund)" {...register('reason')} error={errors.reason?.message} />
        <p className="text-sm text-ink-900">Refund total: <strong className="tabular-nums">{formatINR(total)}</strong></p>
        {rootError?.message && <FormAlert>{rootError.message}</FormAlert>}
        {problem && <FormAlert>{problem}</FormAlert>}
        <Buttons onClose={onClose} busy={isSubmitting} label={`Refund ${formatINR(total)}`} busyLabel="Refunding…" />
      </form>
    </FormDialog>
  );
}

function CancelReturnDialog({ r, onClose, onDone, onRefused }: Props) {
  const { api } = useAuth();
  const [problem, setProblem] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<{ note: string }>({ resolver: zodResolver(returnCancelBody), defaultValues: { note: '' } });
  const save = handleSubmit(async (body) => {
    setProblem(null);
    try { onDone(await api.request<AdminReturnDetail>('POST', `/admin/returns/${r.id}/cancel`, { body })); toast.success(`Return #${r.id} cancelled`); onClose(); }
    catch (e) { if (!applyServerErrors(e, setError, ['note'])) fail(e, onRefused, onClose, setProblem); }
  });
  return (
    <FormDialog open onOpenChange={(v) => { if (!v) onClose(); }} title={`Cancel return #${r.id}?`} description="For a return that won’t come back (e.g. the customer kept the item). The units can be asked for again within the return window.">
      <form noValidate onSubmit={(e) => { void save(e); }} className="space-y-4">
        <NoteField id="cr-note" label="Why (kept on the return)" {...register('note')} error={errors.note?.message} />
        {problem && <FormAlert>{problem}</FormAlert>}
        <Buttons onClose={onClose} busy={isSubmitting} label="Cancel return" busyLabel="Cancelling…" danger />
      </form>
    </FormDialog>
  );
}

function StepDialog({ r, step, onClose, onDone, onRefused }: Props & { step: 'in-transit' | 'close' }) {
  const { api } = useAuth();
  const [busy, setBusy] = useState(false);
  const text = step === 'in-transit'
    ? { title: `Return #${r.id} is on its way back?`, description: 'The customer has sent the parcel (or the pickup is booked).', label: 'Mark on its way', done: 'on its way back' }
    : { title: `Close return #${r.id}?`, description: r.status === 'INSPECTED' ? 'Nothing has been refunded for this return. Close it only if no refund is due.' : 'Everything for this return is done.', label: 'Close return', done: 'closed' };
  const run = async () => {
    setBusy(true);
    try { onDone(await api.request<AdminReturnDetail>('POST', `/admin/returns/${r.id}/${step}`, { body: {} })); toast.success(`Return #${r.id} ${text.done}`); onClose(); }
    catch (e) { onRefused(e); onClose(); }
  };
  return (
    <FormDialog open onOpenChange={(v) => { if (!v) onClose(); }} title={text.title} description={text.description}>
      <div className="flex justify-end gap-3"><button type="button" className={quiet} onClick={onClose}>Back</button><button type="button" className={primary} disabled={busy} onClick={() => void run()}>{busy ? 'Please wait…' : text.label}</button></div>
    </FormDialog>
  );
}
