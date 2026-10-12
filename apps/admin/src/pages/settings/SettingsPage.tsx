// Settings (task 6.5; product.md §7 "Settings") [settings:write, Super Admin]. Store details (on invoices and the
// storefront), payment methods and cash-on-delivery limits, the return window, how shipping is taxed, and who gets
// staff emails. Each section saves on its own after a password re-check; the server's field refusals land on the
// field. Shipping rates, the home page and announcements have their own pages.
import {
  SHIPPING_TAX_RULE_LABEL, SHIPPING_TAX_RULES, storeInfoBody, taxSettingsBody,
  type AdminSettingKey, type AdminSettingsView,
} from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useForm, type FieldValues, type Path, type UseFormSetError } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { useAuth } from '../../auth/AuthProvider';
import { btn } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { applyServerErrors, FormAlert, SelectField, TextField } from '../../components/form';
import { PageHeader } from '../simple';
import { notifyForm, orderForm, PAYMENT_FIELDS, paymentForm, paymentToForm, type NotifyForm, type OrderForm, type PaymentForm } from './forms';

const KEY = ['admin-settings'];
const primary = `${btn} bg-brand-700 text-white disabled:opacity-80`;
const when = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

function Section({ id, title, intro, updated, children }: { id: string; title: string; intro: string; updated: AdminSettingsView['updated'][AdminSettingKey]; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-lg border border-surface-200 bg-white p-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={id} className="text-lg font-semibold text-ink-900">{title}</h2>
        <p className="text-xs text-ink-700">{updated ? `Changed ${when.format(new Date(updated.at))}${updated.by ? ` by ${updated.by}` : ''}` : 'Using the launch defaults'}</p>
      </div>
      <p className="mb-4 max-w-[65ch] text-sm text-ink-700">{intro}</p>
      {children}
    </section>
  );
}

function CheckField({ id, label, help, error, ...input }: { id: string; label: string; help?: string; error?: string | undefined } & React.InputHTMLAttributes<HTMLInputElement> & { ref?: React.Ref<HTMLInputElement> }) {
  const described = [help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex items-start gap-3 text-sm text-ink-900">
      <input id={id} type="checkbox" className="mt-0.5 h-5 w-5 accent-brand-700" aria-invalid={error ? true : undefined} aria-describedby={described} {...input} />
      <div>
        <label htmlFor={id} className="font-medium">{label}</label>
        {help && <p id={`${id}-help`} className="text-ink-700">{help}</p>}
        {error && <p id={`${id}-error`} className="text-danger-700">{error}</p>}
      </div>
    </div>
  );
}

/** Saves one key; the new view replaces the cached one; field refusals land on the form. */
function useSave<F extends FieldValues>(key: AdminSettingKey, setError: UseFormSetError<F>, fields: readonly Path<F>[], label: string) {
  const { api } = useAuth();
  const qc = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const save = async (body: unknown) => {
    setProblem(null);
    try { qc.setQueryData(KEY, await api.request<AdminSettingsView>('PUT', `/admin/settings/${key}`, { body })); toast.success(`${label} saved`); }
    catch (e) { if (!applyServerErrors(e, setError, fields)) setProblem(errorMessage(e)); }
  };
  return { save, problem };
}
const SaveRow = ({ busy, label, problem }: { busy: boolean; label: string; problem: string | null }) => (
  <div className="space-y-3 pt-2">
    {problem && <FormAlert>{problem}</FormAlert>}
    <div className="flex justify-end"><button type="submit" className={primary} disabled={busy}>{busy ? 'Saving…' : label}</button></div>
  </div>
);

function StoreSection({ v }: { v: AdminSettingsView }) {
  const s = v.STORE_INFO;
  const form = useForm<z.input<typeof storeInfoBody>, unknown, z.output<typeof storeInfoBody>>({ resolver: zodResolver(storeInfoBody), defaultValues: {
    name: s.name, legalName: s.legalName ?? '', gstin: s.gstin ?? '', address: s.address ?? '', stateCode: s.stateCode, phone: s.phone ?? '', email: s.email ?? '', whatsapp: s.whatsapp ?? '',
  } });
  const { save, problem } = useSave('STORE_INFO', form.setError, ['name', 'legalName', 'gstin', 'address', 'stateCode', 'phone', 'email', 'whatsapp'], 'Store details');
  const e = form.formState.errors;
  const aErr = e.address?.message;
  return (
    <Section id="set-store" title="Store details" intro="The name, contact details and WhatsApp number appear on the shop. The legal name, GSTIN, address and state are printed on invoices; the state also decides whether an order is taxed as CGST + SGST or IGST." updated={v.updated.STORE_INFO}>
      <form noValidate onSubmit={form.handleSubmit(save)} className="grid gap-3 md:grid-cols-2">
        <TextField id="st-name" label="Store name" {...form.register('name')} error={e.name?.message} />
        <TextField id="st-legal" label="Legal name (optional)" {...form.register('legalName')} error={e.legalName?.message} />
        <TextField id="st-gstin" label="GSTIN (optional)" placeholder="32ABCDE1234F1Z5" autoCapitalize="characters" {...form.register('gstin')} error={e.gstin?.message} />
        <SelectField id="st-state" label="State" {...form.register('stateCode')} error={e.stateCode?.message}>
          {v.states.map((x) => <option key={x.code} value={x.code}>{x.name} ({x.code})</option>)}
        </SelectField>
        <div className="md:col-span-2">
          <label htmlFor="st-address" className="block text-sm font-medium text-ink-900">Registered address (optional)</label>
          <textarea id="st-address" rows={3} className="mt-1 block w-full rounded-md border border-border-input p-2 text-sm" aria-invalid={aErr ? true : undefined} aria-describedby={aErr ? 'st-address-error' : undefined} {...form.register('address')} />
          {aErr && <p id="st-address-error" className="mt-1 text-sm text-danger-700">{aErr}</p>}
        </div>
        <TextField id="st-phone" label="Phone (optional)" placeholder="+91 98470 12345" inputMode="tel" {...form.register('phone')} error={e.phone?.message} />
        <TextField id="st-email" label="Email (optional)" type="email" {...form.register('email')} error={e.email?.message} />
        <TextField id="st-wa" label="WhatsApp (optional)" placeholder="+91 98470 12345" inputMode="tel" hint="Shows the WhatsApp button on the shop." {...form.register('whatsapp')} error={e.whatsapp?.message} />
        <div className="md:col-span-2"><SaveRow busy={form.formState.isSubmitting} label="Save store details" problem={problem} /></div>
      </form>
    </Section>
  );
}

function PaymentSection({ v }: { v: AdminSettingsView }) {
  const form = useForm<PaymentForm, unknown, ReturnType<typeof paymentForm.parse>>({ resolver: zodResolver(paymentForm), defaultValues: paymentToForm(v.PAYMENT) });
  const { save, problem } = useSave('PAYMENT', form.setError, PAYMENT_FIELDS, 'Payment settings');
  const e = form.formState.errors;
  return (
    <Section id="set-pay" title="Payments" intro="Which ways to pay checkout offers, and the cash-on-delivery fee and order limits. Changes apply to new checkouts at once." updated={v.updated.PAYMENT}>
      <form noValidate onSubmit={form.handleSubmit(save)} className="space-y-4">
        <CheckField id="pay-online" label="Pay online (Razorpay)" {...form.register('razorpayEnabled')} error={e.razorpayEnabled?.message} />
        <CheckField id="pay-cod" label="Cash on delivery" help="Pincodes can still turn it off one by one (Shipping Rates)." {...form.register('codEnabled')} error={e.codEnabled?.message} />
        <div className="grid gap-3 md:grid-cols-3">
          <TextField id="pay-fee" label="COD fee (₹)" inputMode="decimal" {...form.register('codFee')} error={e.codFee?.message} />
          <TextField id="pay-min" label="COD from order total (₹)" inputMode="decimal" {...form.register('codMin')} error={e.codMin?.message} />
          <TextField id="pay-max" label="COD up to order total (₹)" inputMode="decimal" {...form.register('codMax')} error={e.codMax?.message} />
        </div>
        <TextField id="pay-expiry" label="Hold stock for an unpaid online order (minutes)" inputMode="numeric" className="md:max-w-xs" hint="Between 5 and 120. After this the order expires and its stock is released." {...form.register('pendingExpiryMinutes')} error={e.pendingExpiryMinutes?.message} />
        <SaveRow busy={form.formState.isSubmitting} label="Save payments" problem={problem} />
      </form>
    </Section>
  );
}

function OrderSection({ v }: { v: AdminSettingsView }) {
  const form = useForm<OrderForm, unknown, ReturnType<typeof orderForm.parse>>({ resolver: zodResolver(orderForm), defaultValues: { returnWindowHours: String(v.ORDER.returnWindowHours) } });
  const { save, problem } = useSave('ORDER', form.setError, ['returnWindowHours'], 'Return window');
  return (
    <Section id="set-order" title="Returns" intro="How long after delivery a customer can ask for a return. 0 turns customer return requests off." updated={v.updated.ORDER}>
      <form noValidate onSubmit={form.handleSubmit(save)} className="space-y-3">
        <TextField id="ord-window" label="Return window (hours after delivery)" inputMode="numeric" className="md:max-w-xs" {...form.register('returnWindowHours')} error={form.formState.errors.returnWindowHours?.message} />
        <SaveRow busy={form.formState.isSubmitting} label="Save return window" problem={problem} />
      </form>
    </Section>
  );
}

function TaxSection({ v }: { v: AdminSettingsView }) {
  const form = useForm<z.input<typeof taxSettingsBody>, unknown, z.output<typeof taxSettingsBody>>({ resolver: zodResolver(taxSettingsBody), defaultValues: { shippingTaxRule: v.TAX.shippingTaxRule } });
  const { save, problem } = useSave('TAX', form.setError, ['shippingTaxRule'], 'Tax settings');
  return (
    <Section id="set-tax" title="Tax" intro="Prices include GST and invoices are made when an order is dispatched. Choose how the shipping charge is taxed on invoices, as your accountant advises. Invoices already made do not change." updated={v.updated.TAX}>
      <form noValidate onSubmit={form.handleSubmit(save)} className="space-y-3">
        <SelectField id="tax-ship" label="Shipping charge" className="md:max-w-xl" {...form.register('shippingTaxRule')} error={form.formState.errors.shippingTaxRule?.message}>
          {SHIPPING_TAX_RULES.map((r) => <option key={r} value={r}>{SHIPPING_TAX_RULE_LABEL[r]}</option>)}
        </SelectField>
        <SaveRow busy={form.formState.isSubmitting} label="Save tax" problem={problem} />
      </form>
    </Section>
  );
}

function NotifySection({ v }: { v: AdminSettingsView }) {
  const form = useForm<NotifyForm, unknown, ReturnType<typeof notifyForm.parse>>({ resolver: zodResolver(notifyForm), defaultValues: { adminEmails: v.NOTIFY.adminEmails.join('\n') } });
  const { save, problem } = useSave('NOTIFY', form.setError, ['adminEmails'], 'Staff emails');
  const err = form.formState.errors.adminEmails?.message;
  return (
    <Section id="set-notify" title="Staff emails" intro="Who gets the shop’s emails to staff: new orders, contact and custom-work messages, payment problems, overdue COD remittances and operations alerts. Up to 10 addresses." updated={v.updated.NOTIFY}>
      <form noValidate onSubmit={form.handleSubmit(save)} className="space-y-3">
        <div className="md:max-w-xl">
          <label htmlFor="nt-emails" className="block text-sm font-medium text-ink-900">Addresses (one per line)</label>
          <textarea id="nt-emails" rows={4} className="mt-1 block w-full rounded-md border border-border-input p-2 text-sm" aria-invalid={err ? true : undefined} aria-describedby={err ? 'nt-emails-error' : undefined} {...form.register('adminEmails')} />
          {err && <p id="nt-emails-error" className="mt-1 text-sm text-danger-700">{err}</p>}
        </div>
        {v.NOTIFY.adminEmails.length === 0 && <p role="status" className="rounded-md bg-[#fef3c7] px-3 py-2 text-sm text-ink-900">No addresses yet, so no staff emails are being sent.</p>}
        <SaveRow busy={form.formState.isSubmitting} label="Save staff emails" problem={problem} />
      </form>
    </Section>
  );
}

export function SettingsPage() {
  const { api } = useAuth();
  const q = useQuery({ queryKey: KEY, queryFn: () => api.request<AdminSettingsView>('GET', '/admin/settings') });
  return (
    <>
      <PageHeader title="Settings" />
      {q.isPending && <p className="text-ink-700" role="status">Loading settings…</p>}
      {q.isError && <FormAlert>{errorMessage(q.error)}</FormAlert>}
      {q.data && (
        <div className="space-y-5">
          <p className="max-w-[65ch] text-sm text-ink-700">Saving asks for your password if you haven’t entered it in the last 10 minutes. Shipping rates, the home page and the announcement bar are on their own pages.</p>
          <StoreSection v={q.data} />
          <PaymentSection v={q.data} />
          <OrderSection v={q.data} />
          <TaxSection v={q.data} />
          <NotifySection v={q.data} />
        </div>
      )}
    </>
  );
}
