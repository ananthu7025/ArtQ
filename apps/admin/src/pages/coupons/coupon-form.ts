// Coupon editor form (task 4.3). The inputs are what the admin types (rupees, a percent, local dates, empty = no limit);
// they are converted to the API body and validated with the shared couponBody, unchanged (CLAUDE.md "Validation rule"):
// every API error has a field of the same name here, so server errors land on the field too.
import { couponBody, type CouponAdminView, type CouponData, type CouponKind, type CouponScopeKind } from '@artq/shared';
import { z } from 'zod';

const RUPEES = /^\d{1,7}(\.\d{1,2})?$/;
const WHOLE = /^\d{1,7}$/;

export type CouponFormValues = {
  code: string; title: string; description: string; type: CouponKind; value: string; maxDiscount: string; minOrderValue: string;
  startsAt: string; endsAt: string; usageLimitTotal: string; usageLimitPerCustomer: string;
  firstOrderOnly: boolean; isPublic: boolean; isActive: boolean; appliesTo: CouponScopeKind; targetIds: number[];
};

export const EMPTY_COUPON: CouponFormValues = {
  code: '', title: '', description: '', type: 'PERCENT', value: '', maxDiscount: '', minOrderValue: '', startsAt: '', endsAt: '',
  usageLimitTotal: '', usageLimitPerCustomer: '1', firstOrderOnly: false, isPublic: false, isActive: true, appliesTo: 'ALL', targetIds: [],
};

const paise = (s: string) => Math.round(Number(s.trim()) * 100);
/** `datetime-local` value (the admin's local time) ↔ ISO instant. */
export const toInstant = (local: string) => (local.trim() === '' ? null : new Date(local).toISOString());
export const toLocal = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const rupeesText = (p: number | null) => (p === null ? '' : (p / 100).toFixed(2).replace(/\.00$/, ''));

export function fromCoupon(c: CouponAdminView): CouponFormValues {
  return {
    code: c.code, title: c.title, description: c.description ?? '', type: c.type,
    value: c.type === 'PERCENT' ? String(c.value) : c.type === 'FLAT' ? rupeesText(c.value) : '',
    maxDiscount: rupeesText(c.maxDiscount), minOrderValue: c.minOrderValue ? rupeesText(c.minOrderValue) : '',
    startsAt: toLocal(c.startsAt), endsAt: toLocal(c.endsAt),
    usageLimitTotal: c.usageLimitTotal === null ? '' : String(c.usageLimitTotal), usageLimitPerCustomer: c.usageLimitPerCustomer === null ? '' : String(c.usageLimitPerCustomer),
    firstOrderOnly: c.firstOrderOnly, isPublic: c.isPublic, isActive: c.isActive, appliesTo: c.appliesTo, targetIds: c.targets.map((t) => t.id),
  };
}

/** The form's own format checks (rupees, whole numbers, real dates); null when the text cannot be converted. */
function formatProblems(v: CouponFormValues): [keyof CouponFormValues, string][] {
  const out: [keyof CouponFormValues, string][] = [];
  if (v.type === 'PERCENT' && v.value.trim() !== '' && !WHOLE.test(v.value.trim())) out.push(['value', 'Use a whole percentage, e.g. 10']);
  if (v.type === 'FLAT' && v.value.trim() !== '' && !RUPEES.test(v.value.trim())) out.push(['value', 'Use rupees with at most two decimals, e.g. 150 or 99.50']);
  for (const k of ['maxDiscount', 'minOrderValue'] as const) if (v[k].trim() !== '' && !RUPEES.test(v[k].trim())) out.push([k, 'Use rupees with at most two decimals, e.g. 150 or 99.50']);
  for (const k of ['usageLimitTotal', 'usageLimitPerCustomer'] as const) if (v[k].trim() !== '' && !WHOLE.test(v[k].trim())) out.push([k, 'Use a whole number, or leave it empty for no limit']);
  for (const k of ['startsAt', 'endsAt'] as const) if (v[k].trim() !== '' && Number.isNaN(Date.parse(v[k]))) out.push([k, 'Enter a date and time']);
  return out;
}

/** The API body for valid form values (only call after formatProblems is empty). */
export function toBody(v: CouponFormValues): unknown {
  return {
    code: v.code, title: v.title, description: v.description.trim() === '' ? null : v.description, type: v.type,
    value: v.type === 'FREE_SHIPPING' ? 0 : v.value.trim() === '' ? undefined : v.type === 'PERCENT' ? Number(v.value) : paise(v.value),
    maxDiscount: v.type === 'PERCENT' && v.maxDiscount.trim() !== '' ? paise(v.maxDiscount) : null,
    minOrderValue: v.minOrderValue.trim() === '' ? 0 : paise(v.minOrderValue),
    startsAt: toInstant(v.startsAt), endsAt: toInstant(v.endsAt),
    usageLimitTotal: v.usageLimitTotal.trim() === '' ? null : Number(v.usageLimitTotal), usageLimitPerCustomer: v.usageLimitPerCustomer.trim() === '' ? null : Number(v.usageLimitPerCustomer),
    firstOrderOnly: v.firstOrderOnly, isPublic: v.isPublic, isActive: v.isActive, appliesTo: v.appliesTo, targetIds: v.appliesTo === 'ALL' ? [] : v.targetIds,
  };
}

/** Form schema: format checks first, then the shared couponBody on the converted values (its messages, its limits). */
export const couponForm = z.custom<CouponFormValues>().transform((v, ctx) => {
  const problems = formatProblems(v);
  for (const [path, message] of problems) ctx.addIssue({ code: 'custom', path: [path], message });
  if (problems.length) return z.NEVER;
  const r = couponBody.safeParse(toBody(v));
  if (!r.success) {
    for (const i of r.error.issues) ctx.addIssue({ code: 'custom', path: i.path.length ? i.path : ['code'], message: i.message });
    return z.NEVER;
  }
  return r.data as CouponData;
});

export const FORM_FIELDS = ['code', 'title', 'description', 'type', 'value', 'maxDiscount', 'minOrderValue', 'startsAt', 'endsAt', 'usageLimitTotal', 'usageLimitPerCustomer', 'firstOrderOnly', 'isPublic', 'isActive', 'appliesTo', 'targetIds'] as const;
