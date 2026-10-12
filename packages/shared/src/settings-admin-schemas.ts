// The admin Settings page (task 6.5; api.md §4.10 "Settings", product.md §7 "Settings") [settings:write + step-up].
// One body per key with only the fields that change something today; the API merges a body into the stored value and
// checks the result with the stored schema (settingSchemas), so fields not shown here keep their values. Shared by the
// API and the form (validation rule). Money in paise.
import { z } from 'zod';
import { emailField } from './auth-schemas.js';
import type { SettingValue } from './settings.js';

export const ADMIN_SETTING_KEYS = ['STORE_INFO', 'PAYMENT', 'ORDER', 'TAX', 'NOTIFY'] as const;
export type AdminSettingKey = (typeof ADMIN_SETTING_KEYS)[number];

const optText = (max: number) => z.string().trim().max(max, `Use at most ${max} characters`).transform((v) => v || null).nullable().default(null);
const PHONE = /^\+?[0-9][0-9 ()-]{7,18}$/;
const optPhone = z.string().trim().refine((v) => v === '' || PHONE.test(v), 'Use a phone number like +91 98470 12345').transform((v) => v || null).nullable().default(null);
const rupees = (max: number, label: string) => z.number({ error: 'Enter an amount' }).int('Use whole paise').min(0, 'Use 0 or more').max(max, `At most ${label}`);

export const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const storeInfoBody = z.strictObject({
  name: z.string({ error: 'Enter the store name' }).trim().min(1, 'Enter the store name').max(120, 'Use at most 120 characters'),
  legalName: optText(200),
  gstin: z.string().trim().toUpperCase().refine((v) => v === '' || GSTIN.test(v), 'Enter a 15-character GSTIN, like 32ABCDE1234F1Z5').transform((v) => v || null).nullable().default(null),
  address: optText(500),
  stateCode: z.string({ error: 'Choose the state' }).regex(/^\d{2}$/, 'Choose the state'),
  phone: optPhone,
  email: emailField.nullable().or(z.literal('').transform(() => null)).default(null),
  whatsapp: optPhone,
}).superRefine((b, ctx) => {
  if (b.gstin && b.gstin.slice(0, 2) !== b.stateCode) ctx.addIssue({ code: 'custom', path: ['gstin'], message: `A GSTIN starts with its state’s code (${b.stateCode} for the state chosen)` });
});

export const paymentSettingsBody = z.strictObject({
  razorpayEnabled: z.boolean(),
  codEnabled: z.boolean(),
  codFee: rupees(100_000, '₹1,000'),
  codMin: rupees(10_000_000, '₹1,00,000'),
  codMax: rupees(10_000_000, '₹1,00,000'),
  pendingExpiryMinutes: z.number({ error: 'Enter minutes' }).int('Use whole minutes').min(5, 'At least 5 minutes').max(120, 'At most 120 minutes'),
}).superRefine((b, ctx) => {
  if (!b.razorpayEnabled && !b.codEnabled) ctx.addIssue({ code: 'custom', path: ['codEnabled'], message: 'Keep at least one way to pay switched on' });
  if (b.codMin > b.codMax) ctx.addIssue({ code: 'custom', path: ['codMax'], message: 'Use at least the minimum' });
});

export const orderSettingsBody = z.strictObject({
  returnWindowHours: z.number({ error: 'Enter hours' }).int('Use whole hours').min(0, 'Use 0 or more (0 = no returns)').max(720, 'At most 720 hours (30 days)'),
});

/** How shipping is taxed on invoices (decision D-3; invoice.ts): both taxed rules use the highest item rate. */
export const SHIPPING_TAX_RULES = ['CA_DECISION', 'TAXED', 'EXEMPT'] as const;
export const SHIPPING_TAX_RULE_LABEL: Record<(typeof SHIPPING_TAX_RULES)[number], string> = {
  CA_DECISION: 'At the highest GST rate in the order (until the accountant decides)',
  TAXED: 'At the highest GST rate in the order (confirmed by the accountant)',
  EXEMPT: 'Not taxed (0 %)',
};
export const taxSettingsBody = z.strictObject({ shippingTaxRule: z.enum(SHIPPING_TAX_RULES, { error: 'Choose a rule' }) });

export const NOTIFY_EMAILS_MAX = 10;
export const notifySettingsBody = z.strictObject({
  adminEmails: z.array(emailField).max(NOTIFY_EMAILS_MAX, `At most ${NOTIFY_EMAILS_MAX} addresses`)
    .refine((l) => new Set(l.map((e) => e.toLowerCase())).size === l.length, 'Each address only once'),
});

export const ADMIN_SETTING_BODIES = { STORE_INFO: storeInfoBody, PAYMENT: paymentSettingsBody, ORDER: orderSettingsBody, TAX: taxSettingsBody, NOTIFY: notifySettingsBody } as const;

/** GET /admin/settings: the five values, the states (for the store's state), and who changed each one last. */
export type AdminSettingsView = { [K in AdminSettingKey]: SettingValue<K> } & {
  states: { code: string; name: string }[];
  updated: Record<AdminSettingKey, { at: string; by: string | null } | null>;
};
