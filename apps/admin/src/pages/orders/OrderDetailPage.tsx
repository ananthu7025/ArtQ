// Order detail (task 5.1; product.md §7.5 "Orders", api.md §4.3) [orders:read; actions orders:fulfil]: the four status
// dimensions, the next step as one button (Confirm → Pack → Ship → Out for delivery → Mark delivered), the packing slip
// and (once shipped) the tax invoice, items
// and totals, payments and refunds, the timeline, customer and delivery address (correctable before packing), the
// staff note, and the emails sent (any fitting one can be sent again). Cancel, refunds, RTO and returns arrive with
// tasks 5.3–5.6. A refused step (someone else moved the order) explains itself and reloads.
import {
  adminNoteField, formatINR, orderAddressBody, shipOrderBody, type AdminOrderDetail, type OrderAction, type ResendableEmail,
} from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, FileText, Printer, Truck } from 'lucide-react';
import { Fragment, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { ApiError } from '../../api/client';
import { saveBlob } from '../../api/upload';
import { useAuth } from '../../auth/AuthProvider';
import { btn, FormDialog } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { applyServerErrors, FormAlert, SelectField, TextField } from '../../components/form';
import { convertedForm, optionalNumber, wholeProblems } from '../../components/form-schema';
import { NotFoundPage } from '../simple';
import { FULFILMENT_LABEL, ORDER_LABEL, PAYMENT_LABEL, Pill, RETURN_LABEL, when } from './labels';

const card = 'rounded-lg border border-surface-200 bg-white p-5';
const primary = `${btn} bg-brand-700 text-white disabled:opacity-80`;
const outline = `${btn} border border-border-input bg-white`;
const quiet = `${btn} text-ink-900 hover:bg-surface-100`;
const h2 = 'mb-3 font-semibold text-ink-900';

type Step = { action: Exclude<OrderAction, 'edit-address' | 'ship'>; label: string; title: string; description: string; notify: boolean };
const STEPS: Step[] = [
  { action: 'confirm', label: 'Confirm order', title: 'Confirm this order?', description: 'You’ve checked the order and will pack it. The customer is told it’s confirmed.', notify: true },
  { action: 'pack', label: 'Mark packed', title: 'Mark as packed?', description: 'Every item is in the box with the packing slip. The address can’t be changed after this.', notify: false },
  { action: 'out-for-delivery', label: 'Out for delivery', title: 'Mark out for delivery?', description: 'The courier says the parcel is out for delivery today.', notify: false },
  { action: 'deliver', label: 'Mark delivered', title: 'Mark as delivered?', description: 'The courier confirmed delivery. For cash on delivery, the cash is now recorded as collected by the courier.', notify: true },
];
const EMAIL_LABEL: Record<ResendableEmail, string> = { order_placed: 'Order placed', order_confirmed: 'Order confirmed', order_shipped: 'Order shipped', order_delivered: 'Order delivered' };
const TEMPLATE_LABEL: Record<string, string> = { ...EMAIL_LABEL, order_expired: 'Order not completed', order_cancelled: 'Order cancelled', payment_refund_notice: 'Refund notice', refund_processed: 'Refund processed', set_password_link: 'Set a password', admin_order_placed: 'New order (staff)' };
const DIMENSION: Record<string, string> = { ORDER: 'Order', PAYMENT: 'Payment', FULFILMENT: 'Fulfilment', RETURN: 'Return' };
const VALUE: Record<string, string> = Object.fromEntries([...Object.entries(ORDER_LABEL), ...Object.entries(PAYMENT_LABEL), ...Object.entries(FULFILMENT_LABEL), ...Object.entries(RETURN_LABEL)].map(([k, [v]]) => [k, v]));

export function OrderDetailPage() {
  const id = Number(useParams().id);
  const { api, can } = useAuth();
  const qc = useQueryClient();
  const key = ['order', id];
  const q = useQuery({ queryKey: key, queryFn: () => api.request<AdminOrderDetail>('GET', `/admin/orders/${id}`), enabled: Number.isSafeInteger(id) && id > 0, retry: false });
  const [step, setStep] = useState<Step | null>(null);
  const [editing, setEditing] = useState(false);
  const [resending, setResending] = useState(false);
  const [shipping, setShipping] = useState(false);
  if (!Number.isSafeInteger(id) || id <= 0 || (q.error instanceof ApiError && q.error.status === 404)) return <NotFoundPage />;
  if (q.isPending) return <p role="status" className="text-ink-700">Loading the order…</p>;
  if (q.isError) return <FormAlert>Couldn’t load this order. <button type="button" className="underline" onClick={() => void q.refetch()}>Retry</button></FormAlert>;
  const o = q.data;
  const fulfil = can('orders:fulfil');
  const set = (d: AdminOrderDetail) => { qc.setQueryData(key, d); void qc.invalidateQueries({ queryKey: ['orders'] }); };
  /** A refusal because the order moved on: say so and show the latest. */
  const refused = (e: unknown) => { toast.error(errorMessage(e)); if (e instanceof ApiError && ['INVALID_TRANSITION', 'VERSION_CONFLICT'].includes(e.code)) void q.refetch(); };
  const next = STEPS.filter((s) => o.actions.includes(s.action));
  const slip = async () => {
    try {
      const blob = await api.download(`/admin/orders/${id}/packing-slip`);
      const url = URL.createObjectURL(blob);
      if (!window.open(url, '_blank', 'noopener')) saveBlob(blob, `packing-slip-${o.orderNumber}.pdf`);   // pop-ups blocked: download it
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { toast.error(errorMessage(e)); }
  };
  const canSlip = ['PLACED', 'CONFIRMED', 'COMPLETED'].includes(o.status);
  const invoice = async () => {
    // Open the tab now (still inside the click), then point it at the signed link: pop-up blockers allow this.
    const tab = window.open('', '_blank');
    try { const { url } = await api.request<{ url: string }>('GET', `/admin/orders/${id}/invoice`); if (tab) tab.location.href = url; else window.location.assign(url); }
    catch (e) { tab?.close(); toast.error(errorMessage(e)); }
  };

  return (
    <div className="space-y-5">
      <Link to="/orders" className="inline-flex items-center gap-1 text-sm font-medium text-brand-700"><ArrowLeft size={16} aria-hidden />All orders</Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink-900">Order <span className="font-mono">{o.orderNumber}</span></h1>
          <p className="mt-1 text-sm text-ink-700">Placed {when(o.placedAt ?? o.createdAt)} · {o.paymentMethod === 'COD' ? 'Cash on delivery' : 'Paid online'}</p>
          <div className="mt-2 flex flex-wrap gap-1" aria-label="Status">
            <Pill label={ORDER_LABEL[o.status]} /><Pill label={PAYMENT_LABEL[o.paymentStatus]} /><Pill label={FULFILMENT_LABEL[o.fulfilmentStatus]} />
            {o.returnStatus !== 'NONE' && <Pill label={RETURN_LABEL[o.returnStatus]} />}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canSlip && <button type="button" className={outline} onClick={() => void slip()}><Printer size={16} aria-hidden className="mr-1" />Packing slip</button>}
          {o.invoices.some((v) => v.kind === 'TAX_INVOICE') && <button type="button" className={outline} onClick={() => void invoice()}><FileText size={16} aria-hidden className="mr-1" />Invoice</button>}
          {fulfil && o.actions.includes('ship') && <button type="button" className={primary} onClick={() => setShipping(true)}><Truck size={16} aria-hidden className="mr-1" />Ship</button>}
          {fulfil && o.resendable.length > 0 && <button type="button" className={outline} onClick={() => setResending(true)}>Resend email</button>}
          {fulfil && next.map((s) => <button key={s.action} type="button" className={primary} onClick={() => setStep(s)}>{s.label}</button>)}
        </div>
      </div>
      {o.hasOpenException && (
        <p role="alert" className="flex items-center gap-2 rounded-md border border-[#fca5a5] bg-[#fee2e2] px-4 py-3 text-sm text-danger-700">
          <AlertTriangle size={16} aria-hidden />This order has an open payment exception. Check the payments below before shipping.
        </p>
      )}
      {o.status === 'PLACED' && !o.actions.includes('confirm') && <p className="text-sm text-ink-700">Waiting for the payment to settle before it can be confirmed.</p>}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Items o={o} />
          <Payments o={o} />
          <Timeline o={o} />
        </div>
        <div className="space-y-5">
          <Customer o={o} />
          <section aria-labelledby="ship-h" className={card}>
            <div className="flex items-start justify-between gap-2">
              <h2 id="ship-h" className={h2}>Delivery address</h2>
              {fulfil && o.actions.includes('edit-address') && <button type="button" className={`${quiet} -mt-2`} onClick={() => setEditing(true)}>Edit</button>}
            </div>
            <address className="text-sm not-italic text-ink-900">
              <span className="block font-medium">{o.shippingAddress.fullName}</span>
              <span className="block">{o.shippingAddress.line1}</span>
              {o.shippingAddress.line2 && <span className="block">{o.shippingAddress.line2}</span>}
              {o.shippingAddress.landmark && <span className="block">Near {o.shippingAddress.landmark}</span>}
              <span className="block">{o.shippingAddress.city}, {o.shippingAddress.state} {o.shippingAddress.pincode}</span>
              <span className="block">Phone {o.shippingAddress.phone}</span>
            </address>
            {(!o.billing.sameAsShipping || o.billing.gstin) && (
              <div className="mt-3 border-t border-surface-200 pt-3 text-sm text-ink-700">
                {o.billing.gstin && <p>GST invoice: <span className="font-medium text-ink-900">{o.billing.businessName}</span> · {o.billing.gstin}</p>}
                {!o.billing.sameAsShipping && <p>Billing address differs from delivery.</p>}
              </div>
            )}
          </section>
          {o.shipment && (
            <section aria-labelledby="shipment-h" className={card}>
              <h2 id="shipment-h" className={h2}>Shipment</h2>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-ink-700">Courier</dt><dd>{o.shipment.courierName}</dd>
                <dt className="text-ink-700">AWB</dt><dd className="font-mono">{o.shipment.trackingUrl ? <a href={o.shipment.trackingUrl} target="_blank" rel="noreferrer" className="text-brand-700 underline">{o.shipment.awbNumber}</a> : o.shipment.awbNumber}</dd>
                {o.shipment.shippedAt && <><dt className="text-ink-700">Shipped</dt><dd>{when(o.shipment.shippedAt)}</dd></>}
                {o.shipment.deliveredAt && <><dt className="text-ink-700">Delivered</dt><dd>{when(o.shipment.deliveredAt)}</dd></>}
                {o.invoices.map((v) => <Fragment key={v.id}><dt className="text-ink-700">{v.kind === 'TAX_INVOICE' ? 'Invoice' : 'Credit note'}</dt><dd className="font-mono">{v.number}</dd></Fragment>)}
              </dl>
            </section>
          )}
          <Notes o={o} canEdit={fulfil} onSaved={set} onRefused={refused} />
          <Emails o={o} />
        </div>
      </div>

      {step && <StepDialog key={step.action} step={step} o={o} onClose={() => setStep(null)} onDone={set} onRefused={refused} />}
      {editing && <AddressDialog o={o} onClose={() => setEditing(false)} onDone={set} onRefused={refused} />}
      {shipping && <ShipDialog o={o} onClose={() => setShipping(false)} onDone={set} onRefused={refused} />}
      {resending && <ResendDialog o={o} onClose={() => setResending(false)} onDone={set} onRefused={refused} />}
    </div>
  );
}

function Items({ o }: { o: AdminOrderDetail }) {
  const t = o.totals;
  const row = (label: string, value: string, cls = '') => <div className="flex justify-between gap-4"><dt className="text-ink-700">{label}</dt><dd className={`tabular-nums ${cls}`}>{value}</dd></div>;
  return (
    <section aria-labelledby="items-h" className={card}>
      <h2 id="items-h" className={h2}>Items</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Items in this order</caption>
          <thead><tr className="border-b border-surface-200 text-left text-ink-700"><th scope="col" className="py-2 font-medium">Item</th><th scope="col" className="py-2 font-medium">SKU</th><th scope="col" className="py-2 text-right font-medium">Price</th><th scope="col" className="py-2 text-right font-medium">Qty</th><th scope="col" className="py-2 text-right font-medium">Total</th></tr></thead>
          <tbody>
            {o.items.map((i) => (
              <tr key={i.id} className="border-b border-surface-100 align-top">
                <td className="py-2 pr-3">{i.productId ? <Link to={`/products/${i.productId}`} className="font-medium text-ink-900 hover:underline">{i.name}</Link> : <span className="font-medium">{i.name}</span>}<div className="text-ink-700">{i.label}</div>
                  {(i.refundedQty > 0 || i.returnedQty > 0) && <div className="text-xs text-warning-ink">{i.refundedQty > 0 && `${i.refundedQty} refunded `}{i.returnedQty > 0 && `${i.returnedQty} returned`}</div>}</td>
                <td className="py-2 pr-3 font-mono text-xs text-ink-700">{i.sku}</td>
                <td className="py-2 text-right tabular-nums">{formatINR(i.unitPrice)}</td>
                <td className="py-2 text-right tabular-nums">{i.quantity}</td>
                <td className="py-2 text-right tabular-nums">{formatINR(i.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="ml-auto mt-4 flex max-w-xs flex-col gap-1 text-sm">
        {row('Subtotal', formatINR(t.subtotal))}
        {t.couponDiscount > 0 && row(`Coupon ${t.couponCode ?? ''}`.trim(), `−${formatINR(t.couponDiscount)}`, 'text-success-700')}
        {row('Shipping', t.shippingFee === 0 ? 'Free' : formatINR(t.shippingFee))}
        {t.codFee > 0 && row('COD fee', formatINR(t.codFee))}
        <div className="flex justify-between gap-4 border-t border-surface-200 pt-1 font-semibold"><dt>Total</dt><dd className="tabular-nums">{formatINR(t.total)}</dd></div>
        {t.refundedAmount > 0 && row('Refunded', `−${formatINR(t.refundedAmount)}`, 'text-danger-700')}
      </dl>
      <p className="ml-auto mt-1 max-w-xs text-xs text-ink-700">Weight {(o.weights.chargeableG / 1000).toLocaleString('en-IN')} kg chargeable</p>
    </section>
  );
}

function Payments({ o }: { o: AdminOrderDetail }) {
  if (o.paymentMethod === 'COD' && o.payments.length === 0 && o.refunds.length === 0) return null;
  return (
    <section aria-labelledby="pay-h" className={card}>
      <h2 id="pay-h" className={h2}>Payments</h2>
      {o.payments.length === 0 && o.attempts.length > 0 && <p className="text-sm text-ink-700">{o.attempts.length} payment attempt{o.attempts.length === 1 ? '' : 's'}, no payment received.</p>}
      <ul className="divide-y divide-surface-100 text-sm">
        {o.payments.map((p) => (
          <li key={p.id} className="flex flex-wrap justify-between gap-2 py-2">
            <span><span className="font-mono">{p.providerPaymentId}</span> <span className="text-ink-700">· {p.method ?? 'online'} · {p.status.toLowerCase()}{p.allocation && p.allocation !== 'APPLIED' ? ` · ${p.allocation.toLowerCase()}` : ''}</span></span>
            <span className="tabular-nums font-medium">{formatINR(p.amount)}{p.amountRefunded > 0 && <span className="ml-2 text-danger-700">−{formatINR(p.amountRefunded)}</span>}</span>
          </li>
        ))}
        {o.refunds.map((r) => (
          <li key={`r${r.id}`} className="flex flex-wrap justify-between gap-2 py-2">
            <span>Refund #{r.id} <span className="text-ink-700">· {r.kind.toLowerCase().replace(/_/g, ' ')} · {r.status.toLowerCase()}</span></span>
            <span className="tabular-nums font-medium text-danger-700">−{formatINR(r.amount)}</span>
          </li>
        ))}
      </ul>
      {o.exceptions.length > 0 && <p className="mt-2 text-sm text-ink-700">Exceptions: {o.exceptions.map((e) => `${e.type.toLowerCase().replace(/_/g, ' ')} (${e.status.toLowerCase()})`).join(', ')}</p>}
    </section>
  );
}

function Timeline({ o }: { o: AdminOrderDetail }) {
  return (
    <section aria-labelledby="tl-h" className={card}>
      <h2 id="tl-h" className={h2}>Timeline</h2>
      <ol className="space-y-2 text-sm">
        {[...o.history].reverse().map((h, n) => (
          <li key={n} className="flex flex-wrap justify-between gap-2">
            <span><span className="font-medium text-ink-900">{DIMENSION[h.dimension] ?? h.dimension}: {VALUE[h.to] ?? h.to}</span>
              <span className="text-ink-700"> · {h.actorName ?? ({ CUSTOMER: 'customer', SYSTEM: 'system', WEBHOOK: 'payment provider', ADMIN: 'staff' } as Record<string, string>)[h.actor] ?? h.actor}</span>
              {h.note && <span className="block text-ink-700">{h.note}</span>}</span>
            <time dateTime={h.at} className="text-ink-700">{when(h.at)}</time>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Customer({ o }: { o: AdminOrderDetail }) {
  return (
    <section aria-labelledby="cust-h" className={card}>
      <h2 id="cust-h" className={h2}>Customer</h2>
      <p className="font-medium text-ink-900">{o.customer.name}</p>
      <p className="text-sm text-ink-700">{o.customer.isGuest ? 'Guest checkout' : 'Has an account'}{o.contactEmailVerified ? ' · email verified' : ''}</p>
      <p className="mt-2 text-sm">{o.customer.email}</p>
      <p className="text-sm">{o.customer.phone}</p>
      {o.contactMasked && <p className="mt-2 text-xs text-ink-700">Contact details are partly hidden for your role. The delivery phone is shown for the courier.</p>}
    </section>
  );
}

const noteForm = z.object({ adminNote: adminNoteField });

function Notes({ o, canEdit, onSaved, onRefused }: { o: AdminOrderDetail; canEdit: boolean; onSaved: (d: AdminOrderDetail) => void; onRefused: (e: unknown) => void }) {
  const { api } = useAuth();
  const form = useForm<{ adminNote: string | null }, unknown, { adminNote: string | null }>({ resolver: zodResolver(noteForm), defaultValues: { adminNote: o.notes.admin ?? '' } });
  const [problem, setProblem] = useState<string | null>(null);
  const save = form.handleSubmit(async ({ adminNote }) => {
    setProblem(null);
    try { const d = await api.request<AdminOrderDetail>('PATCH', `/admin/orders/${o.id}`, { body: { version: o.version, adminNote } }); onSaved(d); form.reset({ adminNote: d.notes.admin ?? '' }); toast.success('Note saved'); }
    catch (e) { if (!applyServerErrors(e, form.setError, ['adminNote'])) { if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') onRefused(e); else setProblem(errorMessage(e)); } }
  });
  const err = form.formState.errors.adminNote?.message;
  return (
    <section aria-labelledby="notes-h" className={card}>
      <h2 id="notes-h" className={h2}>Notes</h2>
      {o.notes.customer && <p className="mb-3 rounded-md bg-surface-100 p-3 text-sm"><span className="font-medium">From the customer:</span> {o.notes.customer}</p>}
      {canEdit ? (
        <form noValidate onSubmit={(e) => { void save(e); }} className="space-y-2">
          <label htmlFor="admin-note" className="block text-sm font-medium text-ink-900">Staff note (not shown to the customer)</label>
          <textarea id="admin-note" rows={3} className="block w-full rounded-md border border-border-input p-2 text-sm" aria-invalid={err ? true : undefined} aria-describedby={err ? 'admin-note-error' : undefined} {...form.register('adminNote')} />
          {err && <p id="admin-note-error" className="text-sm text-danger-700">{err}</p>}
          {problem && <FormAlert>{problem}</FormAlert>}
          <button type="submit" className={outline} disabled={!form.formState.isDirty || form.formState.isSubmitting}>{form.formState.isSubmitting ? 'Saving…' : 'Save note'}</button>
        </form>
      ) : <p className="text-sm text-ink-700">{o.notes.admin ?? 'No staff note.'}</p>}
    </section>
  );
}

function Emails({ o }: { o: AdminOrderDetail }) {
  return (
    <section aria-labelledby="emails-h" className={card}>
      <h2 id="emails-h" className={h2}>Emails</h2>
      {o.emails.length === 0 ? <p className="text-sm text-ink-700">No email sent for this order yet.</p> : (
        <ul className="space-y-1 text-sm">
          {o.emails.map((e) => (
            <li key={e.id} className="flex flex-wrap justify-between gap-2"><span>{TEMPLATE_LABEL[e.template] ?? e.template} <span className="text-ink-700">· {e.to}</span></span>
              <span className={e.status === 'FAILED' ? 'text-danger-700' : 'text-ink-700'}>{e.status === 'SENT' ? when(e.at) : e.status.toLowerCase()}</span></li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StepDialog({ step, o, onClose, onDone, onRefused }: { step: Step; o: AdminOrderDetail; onClose: () => void; onDone: (d: AdminOrderDetail) => void; onRefused: (e: unknown) => void }) {
  const { api } = useAuth();
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { onDone(await api.request<AdminOrderDetail>('POST', `/admin/orders/${o.id}/${step.action}`, { body: step.notify ? { notifyCustomer: notify } : {} })); toast.success(`${o.orderNumber}: ${step.label.replace(/^Mark /, '').toLowerCase()}`); onClose(); }
    catch (e) { onRefused(e); onClose(); }
  };
  return (
    <FormDialog open onOpenChange={(v) => { if (!v) onClose(); }} title={step.title} description={step.description}>
      <div className="space-y-4">
        {step.notify && <label className="flex items-center gap-3 text-sm text-ink-900"><input type="checkbox" className="h-5 w-5 accent-brand-700" checked={notify} onChange={(e) => setNotify(e.target.checked)} />Email the customer</label>}
        <div className="flex justify-end gap-3">
          <button type="button" className={quiet} onClick={onClose}>Cancel</button>
          <button type="button" className={primary} disabled={busy} onClick={() => void run()}>{busy ? 'Please wait…' : step.label}</button>
        </div>
      </div>
    </FormDialog>
  );
}

type AddressForm = { fullName: string; phone: string; line1: string; line2: string; landmark: string; city: string; stateId: number | undefined; pincode: string };
const ADDRESS_FIELDS = ['fullName', 'phone', 'line1', 'line2', 'landmark', 'city', 'stateId', 'pincode'] as const;

function AddressDialog({ o, onClose, onDone, onRefused }: { o: AdminOrderDetail; onClose: () => void; onDone: (d: AdminOrderDetail) => void; onRefused: (e: unknown) => void }) {
  const { api } = useAuth();
  const states = useQuery({ queryKey: ['states'], queryFn: () => api.request<{ data: { id: number; name: string }[] }>('GET', '/states'), staleTime: 3_600_000 });
  const [problem, setProblem] = useState<string | null>(null);
  const a = o.shippingAddress;
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<AddressForm, unknown, ReturnType<typeof orderAddressBody.parse>>({
    resolver: zodResolver(orderAddressBody) as never,
    defaultValues: { fullName: a.fullName, phone: a.phone, line1: a.line1, line2: a.line2 ?? '', landmark: a.landmark ?? '', city: a.city, stateId: a.stateId ?? undefined, pincode: a.pincode },
  });
  const save = handleSubmit(async (shippingAddress) => {
    setProblem(null);
    try { onDone(await api.request<AdminOrderDetail>('PATCH', `/admin/orders/${o.id}`, { body: { version: o.version, shippingAddress } })); toast.success('Delivery address saved'); onClose(); }
    catch (e) {
      // The server names fields `shippingAddress.<field>`; this form's fields are the address itself.
      if (e instanceof ApiError && Array.isArray(e.details)) for (const d of e.details as { path?: string }[]) if (d.path?.startsWith('shippingAddress.')) d.path = d.path.slice('shippingAddress.'.length);
      if (applyServerErrors(e, setError, ADDRESS_FIELDS)) return;
      if (e instanceof ApiError && ['INVALID_TRANSITION', 'VERSION_CONFLICT'].includes(e.code)) { onRefused(e); onClose(); return; }
      setProblem(errorMessage(e));
    }
  });
  return (
    <FormDialog open onOpenChange={(v) => { if (!v) onClose(); }} title="Correct the delivery address" description="Only before packing. The shipping charge already paid stays the same; the new pincode must be one we deliver to.">
      <form noValidate onSubmit={(e) => { void save(e); }} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField id="a-name" label="Full name" {...register('fullName')} error={errors.fullName?.message} />
          <TextField id="a-phone" label="Phone" inputMode="tel" {...register('phone')} error={errors.phone?.message} />
        </div>
        <TextField id="a-line1" label="House / flat, building and street" {...register('line1')} error={errors.line1?.message} />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField id="a-line2" label="Area (optional)" {...register('line2')} error={errors.line2?.message} />
          <TextField id="a-landmark" label="Landmark (optional)" {...register('landmark')} error={errors.landmark?.message} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField id="a-city" label="City / town" {...register('city')} error={errors.city?.message} />
          <SelectField id="a-state" label="State" {...register('stateId', { setValueAs: (v: string | number | undefined) => (v === '' || v === undefined ? undefined : Number(v)) })} error={errors.stateId?.message}>
            <option value="">Choose…</option>
            {(states.data?.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </SelectField>
          <TextField id="a-pincode" label="Pincode" inputMode="numeric" maxLength={6} {...register('pincode')} error={errors.pincode?.message} />
        </div>
        {problem && <FormAlert>{problem}</FormAlert>}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" className={quiet} onClick={onClose}>Cancel</button>
          <button type="submit" className={primary} disabled={isSubmitting}>{isSubmitting ? 'Saving…' : 'Save address'}</button>
        </div>
      </form>
    </FormDialog>
  );
}

function ResendDialog({ o, onClose, onDone, onRefused }: { o: AdminOrderDetail; onClose: () => void; onDone: (d: AdminOrderDetail) => void; onRefused: (e: unknown) => void }) {
  const { api } = useAuth();
  const [template, setTemplate] = useState<ResendableEmail>(o.resendable.at(-1)!);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try { onDone(await api.request<AdminOrderDetail>('POST', `/admin/orders/${o.id}/resend-email`, { body: { template } })); toast.success(`“${EMAIL_LABEL[template]}” email queued`); onClose(); }
    catch (e) { onRefused(e); onClose(); }
  };
  return (
    <FormDialog open onOpenChange={(v) => { if (!v) onClose(); }} title="Resend an email" description={`To ${o.customer.email}. It reflects the order as it is now.`}>
      <div className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink-900">Email</legend>
          {o.resendable.map((t) => <label key={t} className="flex items-center gap-3 text-sm"><input type="radio" name="resend" className="h-4 w-4 accent-brand-700" checked={template === t} onChange={() => setTemplate(t)} />{EMAIL_LABEL[t]}</label>)}
        </fieldset>
        <div className="flex justify-end gap-3">
          <button type="button" className={quiet} onClick={onClose}>Cancel</button>
          <button type="button" className={primary} disabled={busy} onClick={() => void send()}>{busy ? 'Sending…' : 'Send'}</button>
        </div>
      </div>
    </FormDialog>
  );
}

type ShipForm = { courierName: string; awbNumber: string; trackingUrl: string; weightG: string; notifyCustomer: boolean };
const shipForm = convertedForm<ShipForm, typeof shipOrderBody>(
  (v) => wholeProblems([[['weightG'], v.weightG]], 'Use whole grams'),
  (v) => ({ ...v, weightG: optionalNumber(v.weightG) }),
  shipOrderBody,
);
const SHIP_FIELDS = ['courierName', 'awbNumber', 'trackingUrl', 'weightG'] as const;

function ShipDialog({ o, onClose, onDone, onRefused }: { o: AdminOrderDetail; onClose: () => void; onDone: (d: AdminOrderDetail) => void; onRefused: (e: unknown) => void }) {
  const { api } = useAuth();
  const [problem, setProblem] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<ShipForm, unknown, ReturnType<typeof shipForm.parse>>({
    resolver: zodResolver(shipForm), defaultValues: { courierName: '', awbNumber: '', trackingUrl: '', weightG: String(o.weights.chargeableG), notifyCustomer: true },
  });
  const save = handleSubmit(async (body) => {
    setProblem(null);
    try { onDone(await api.request<AdminOrderDetail>('POST', `/admin/orders/${o.id}/ship`, { body })); toast.success(`${o.orderNumber} shipped; invoice issued`); onClose(); }
    catch (e) {
      if (applyServerErrors(e, setError, SHIP_FIELDS)) return;
      if (e instanceof ApiError && ['INVALID_TRANSITION', 'VERSION_CONFLICT'].includes(e.code)) { onRefused(e); onClose(); return; }
      setProblem(errorMessage(e));
    }
  });
  return (
    <FormDialog open onOpenChange={(v) => { if (!v) onClose(); }} title="Ship this order" description="Hands the parcel to the courier: the stock leaves the shelf and the tax invoice is issued with the next number. This can’t be undone.">
      <form noValidate onSubmit={(e) => { void save(e); }} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField id="s-courier" label="Courier" autoComplete="off" {...register('courierName')} error={errors.courierName?.message} />
          <TextField id="s-awb" label="AWB / tracking number" autoComplete="off" {...register('awbNumber')} error={errors.awbNumber?.message} />
        </div>
        <TextField id="s-url" label="Tracking link (optional)" inputMode="url" placeholder="https://" {...register('trackingUrl')} error={errors.trackingUrl?.message} />
        <TextField id="s-weight" label="Parcel weight (grams, optional)" inputMode="numeric" {...register('weightG')} error={errors.weightG?.message} />
        <label className="flex items-center gap-3 text-sm text-ink-900"><input type="checkbox" className="h-5 w-5 accent-brand-700" {...register('notifyCustomer')} />Email the customer the tracking details</label>
        {problem && <FormAlert>{problem}</FormAlert>}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" className={quiet} onClick={onClose}>Cancel</button>
          <button type="submit" className={primary} disabled={isSubmitting}>{isSubmitting ? 'Shipping…' : 'Ship and issue invoice'}</button>
        </div>
      </form>
    </FormDialog>
  );
}
