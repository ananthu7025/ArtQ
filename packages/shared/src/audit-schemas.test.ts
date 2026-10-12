// Audit filters and the before/after diff (task 6.5).
import { describe, expect, it } from 'vitest';
import { auditFilters, auditListQuery, diffAudit } from './audit-schemas.js';

describe('diffAudit', () => {
  it('changed fields only, as dotted paths, sorted; nested objects opened, arrays compared whole', () => {
    expect(diffAudit({ a: 1, b: { c: 1, d: 2 }, list: [1, 2], same: 'x' }, { a: 2, b: { c: 1, d: 3 }, list: [1, 2, 3], same: 'x', added: null })).toEqual([
      { path: 'a', before: 1, after: 2 }, { path: 'added', before: undefined, after: null }, { path: 'b.d', before: 2, after: 3 }, { path: 'list', before: [1, 2], after: [1, 2, 3] },
    ]);
  });
  it('a removed field; a created or deleted record; scalars; nothing changed', () => {
    expect(diffAudit({ gone: 1 }, {})).toEqual([{ path: 'gone', before: 1, after: undefined }]);
    expect(diffAudit(null, { a: 1 })).toEqual([{ path: '(value)', before: null, after: { a: 1 } }]);
    expect(diffAudit('DRAFT', 'ACTIVE')).toEqual([{ path: '(value)', before: 'DRAFT', after: 'ACTIVE' }]);
    expect(diffAudit({ a: { b: 1 } }, { a: { b: 1 } })).toEqual([]);
    expect(diffAudit({ a: { b: 1 } }, { a: 'flat' })).toEqual([{ path: 'a', before: { b: 1 }, after: 'flat' }]);
  });
});

describe('filters', () => {
  it('dates are real India days, "to" on or after "from" (the same day allowed); unknown keys refused', () => {
    expect(auditFilters.safeParse({ from: '2026-10-01', to: '2026-10-01' }).success).toBe(true);
    expect(auditFilters.safeParse({ from: '2026-10-02', to: '2026-10-01' }).error!.issues[0]).toMatchObject({ path: ['to'], message: 'Use a day on or after “from”' });
    expect(auditFilters.safeParse({ from: '2026-02-30' }).success).toBe(false);
    expect(auditFilters.safeParse({ page: '2' }).success).toBe(false);
    expect(auditFilters.parse({ actorId: '7' })).toEqual({ actorId: 7 });
  });
  it('the list query: defaults, limit ≤ 100, sort values, the same date rule', () => {
    expect(auditListQuery.parse({})).toEqual({ page: 1, limit: 25, sort: '-createdAt' });
    expect(auditListQuery.safeParse({ limit: '100' }).success).toBe(true);
    expect(auditListQuery.safeParse({ limit: '101' }).success).toBe(false);
    expect(auditListQuery.safeParse({ sort: 'action' }).success).toBe(false);
    expect(auditListQuery.safeParse({ from: '2026-10-02', to: '2026-10-01' }).success).toBe(false);
    expect(auditListQuery.safeParse({ entityId: 'x'.repeat(41) }).success).toBe(false);
  });
});
