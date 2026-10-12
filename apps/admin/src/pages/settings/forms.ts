// Settings forms (task 6.5): text inputs in the admin's units (rupees, hours, one email per line) converted to the
// shared bodies (@artq/shared settings-admin-schemas), whose rules land on the same fields (validation rule).
import { notifySettingsBody, orderSettingsBody, paymentSettingsBody, type AdminSettingsView } from '@artq/shared';
import { convertedForm, fromPaise, rupeeProblems, toPaise, wholeProblems } from '../../components/form-schema';

const money = (s: string) => (s.trim() === '' ? undefined : toPaise(s));
const whole = (s: string) => (s.trim() === '' ? undefined : Number(s.trim()));

export type PaymentForm = { razorpayEnabled: boolean; codEnabled: boolean; codFee: string; codMin: string; codMax: string; pendingExpiryMinutes: string };
export const paymentToForm = (p: AdminSettingsView['PAYMENT']): PaymentForm => ({
  razorpayEnabled: p.razorpayEnabled, codEnabled: p.codEnabled, codFee: fromPaise(p.codFee), codMin: fromPaise(p.codMin), codMax: fromPaise(p.codMax), pendingExpiryMinutes: String(p.pendingExpiryMinutes),
});
export const paymentForm = convertedForm<PaymentForm, typeof paymentSettingsBody>(
  (v) => [...rupeeProblems([[['codFee'], v.codFee], [['codMin'], v.codMin], [['codMax'], v.codMax]]), ...wholeProblems([[['pendingExpiryMinutes'], v.pendingExpiryMinutes]], 'Use whole minutes')],
  (v) => ({ razorpayEnabled: v.razorpayEnabled, codEnabled: v.codEnabled, codFee: money(v.codFee), codMin: money(v.codMin), codMax: money(v.codMax), pendingExpiryMinutes: whole(v.pendingExpiryMinutes) }),
  paymentSettingsBody,
);
export const PAYMENT_FIELDS = ['razorpayEnabled', 'codEnabled', 'codFee', 'codMin', 'codMax', 'pendingExpiryMinutes'] as const;

export type OrderForm = { returnWindowHours: string };
export const orderForm = convertedForm<OrderForm, typeof orderSettingsBody>(
  (v) => wholeProblems([[['returnWindowHours'], v.returnWindowHours]], 'Use whole hours'),
  (v) => ({ returnWindowHours: whole(v.returnWindowHours) }),
  orderSettingsBody,
);

/** One address per line (or separated by commas); an error on one address goes on the box. */
export type NotifyForm = { adminEmails: string };
export const notifyForm = convertedForm<NotifyForm, typeof notifySettingsBody>(
  () => [],
  (v) => ({ adminEmails: v.adminEmails.split(/[\s,;]+/).filter(Boolean) }),
  notifySettingsBody,
  () => ['adminEmails'],
);
