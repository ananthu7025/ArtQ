// Audit Logs (task 2.1 list; task 6.5 detail, before/after and export; api.md §4.10) [audit:read; export + step-up].
// Filters shared by the API and the page; `diffAudit` turns a before/after pair into the fields that changed.
import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-05').refine((s) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; }, 'Use a real date');

const filterShape = {
  action: z.string().trim().min(1).max(60).optional(),
  entity: z.string().trim().min(1).max(40).optional(),
  entityId: z.string().trim().min(1).max(40).optional(),
  actorId: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
};
const dayOrder = (q: { from?: string | undefined; to?: string | undefined }) => !q.from || !q.to || q.from <= q.to;
const dayOrderIssue = { path: ['to'], message: 'Use a day on or after “from”' };
/** Filters for the list and the export. `from`/`to` are India calendar days, inclusive. */
export const auditFilters = z.strictObject(filterShape).refine(dayOrder, dayOrderIssue);
export const auditListQuery = z.strictObject({
  ...filterShape,
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['createdAt', '-createdAt']).default('-createdAt'),
}).refine(dayOrder, dayOrderIssue);
/** The export stops here; narrow the filters for more. */
export const AUDIT_EXPORT_MAX = 10_000;

export type AuditActor = { id: number; email: string | null; name: string | null } | null;
export type AuditRow = { id: string; createdAt: string; action: string; entity: string; entityId: string | null; actor: AuditActor; ip: string | null };
export type AuditDetail = AuditRow & { sessionId: string | null; userAgent: string | null; before: unknown; after: unknown };

export type AuditChange = { path: string; before: unknown; after: unknown };
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The fields that differ between `before` and `after`, as dotted paths (objects are opened up; arrays and other values
 * are compared whole). A value only on one side shows `undefined` on the other. Unchanged fields are left out.
 */
export function diffAudit(before: unknown, after: unknown, prefix = ''): AuditChange[] {
  if (!isPlain(before) || !isPlain(after)) return same(before, after) ? [] : [{ path: prefix || '(value)', before, after }];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap((k) => {
    const path = prefix ? `${prefix}.${k}` : k;
    const b = before[k], a = after[k];
    if (isPlain(b) && isPlain(a)) return diffAudit(b, a, path);
    return same(b, a) ? [] : [{ path, before: b, after: a }];
  });
}
