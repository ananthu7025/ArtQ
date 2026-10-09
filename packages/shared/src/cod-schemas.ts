// COD remittances (task 5.6; architecture.md §10.5, api.md §4.7, database.md §8.4a). Shared by the API and the form
// (validation rule). Money in paise. A courier pays out the cash it collected for a batch of delivered COD orders; staff
// record each payout with the courier's reference, and every order in it is marked remitted.
import { z } from 'zod';

export const COD_OVERDUE_DAYS = 14;
const isoDay = z.string({ error: 'Enter the date' }).regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-05')
  .refine((s) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; }, 'Use a real date');   // 2026-02-30 is not a day
const paise = (what: string) => z.number({ error: `Enter ${what}` }).int('Use whole paise').min(1, 'Enter more than ₹0').max(1_000_000_000, 'At most ₹1,00,00,000');

/** POST /admin/cod-remittances [cod:remit]. `remittedAt` is the India calendar day the courier paid. */
export const codRemittanceBody = z.strictObject({
  courierName: z.string({ error: 'Enter the courier' }).trim().min(2, 'Enter the courier').max(80, 'Use at most 80 characters'),
  reference: z.string({ error: 'Enter the payout reference' }).trim().min(3, 'Enter the payout reference').max(80, 'Use at most 80 characters'),
  remittedAt: isoDay,
  amount: paise('the amount paid'),
  note: z.string().trim().max(500, 'Use at most 500 characters').transform((v) => v || null).nullable().default(null),
  orders: z.array(z.strictObject({
    orderNumber: z.string({ error: 'Enter the order number' }).trim().toUpperCase().regex(/^[A-Z0-9-]{3,20}$/, 'Enter an order number like AQ10234'),
    amount: paise('the amount for this order'),
  })).min(1, 'Add at least one order').max(500, 'At most 500 orders'),
}).superRefine((b, ctx) => {
  const seen = new Set<string>();
  b.orders.forEach((o, i) => { if (seen.has(o.orderNumber)) ctx.addIssue({ code: 'custom', path: ['orders', i, 'orderNumber'], message: 'Each order only once' }); seen.add(o.orderNumber); });
  const sum = b.orders.reduce((s, o) => s + o.amount, 0);
  if (b.orders.length > 0 && sum !== b.amount) ctx.addIssue({ code: 'custom', path: ['amount'], message: `The orders add up to ₹${(sum / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` });
});
export type CodRemittanceInput = z.input<typeof codRemittanceBody>;

export const codOutstandingQuery = z.strictObject({
  courier: z.string().trim().min(1).max(80).optional(),
  overdue: z.literal('1').optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
export const codRemittanceListQuery = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** A delivered COD order whose cash the courier has not paid out yet. */
export type CodOutstandingRow = { orderId: number; orderNumber: string; customerName: string; courierName: string | null; awbNumber: string | null; total: number; deliveredAt: string | null; days: number; overdue: boolean };
export type CodOutstandingSummary = { count: number; total: number; overdueCount: number; overdueTotal: number };
export type CodRemittanceRow = {
  id: number; courierName: string; reference: string; amount: number; remittedAt: string; note: string | null; recordedBy: string | null; createdAt: string;
  orders: { orderId: number; orderNumber: string; amount: number; expected: number }[];
};
export type CodRemittanceResult = { remittance: CodRemittanceRow; mismatches: { orderNumber: string; expected: number; remitted: number }[] };
