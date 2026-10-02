// Inventory requests (api.md §4.5), shared by the API and the Inventory page (CLAUDE.md "Validation rule").
// On-hand only: these schemas have no price, MRP, status or reserved fields (unknown keys → 400, AT-10).
import { z } from 'zod';

export const ADJUSTMENT_KINDS = ['RECOUNT', 'ADJUSTMENT', 'DAMAGE_WRITE_OFF'] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];
export const MAX_UNITS = 100_000;

export const adjustmentRow = z.strictObject({
  variantId: z.number().int().positive(),
  kind: z.enum(ADJUSTMENT_KINDS, { error: 'Choose recount, adjustment or write-off' }),
  quantity: z.number({ error: 'Enter a quantity' }).int('Use whole units').min(-MAX_UNITS, `At most ${MAX_UNITS} units`).max(MAX_UNITS, `At most ${MAX_UNITS} units`),
  note: z.string().trim().max(300, 'Use at most 300 characters').optional(),
}).superRefine((r, ctx) => {
  // RECOUNT = the counted quantity; ADJUSTMENT = a change (+/−); DAMAGE_WRITE_OFF = units removed.
  if (r.kind === 'RECOUNT' && r.quantity < 0) ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'A count cannot be negative' });
  if (r.kind === 'ADJUSTMENT' && r.quantity === 0) ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'Enter a change other than 0 (use − to remove units)' });
  if (r.kind === 'DAMAGE_WRITE_OFF' && r.quantity <= 0) ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'Enter how many units to write off' });
  if (r.kind !== 'RECOUNT' && !r.note) ctx.addIssue({ code: 'custom', path: ['note'], message: 'Give a reason' });
});
export type AdjustmentRow = z.infer<typeof adjustmentRow>;

export const adjustmentsBody = z.strictObject({
  rows: z.array(adjustmentRow).min(1, 'Nothing to change').max(200, 'At most 200 rows at a time')
    .refine((rows) => new Set(rows.map((r) => r.variantId)).size === rows.length, 'A variant is listed twice'),
});

export const INVENTORY_STOCK_FILTERS = ['low', 'out', 'oversold', 'uncounted'] as const;
export const inventoryListQuery = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  stock: z.enum(INVENTORY_STOCK_FILTERS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const movementsQuery = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
