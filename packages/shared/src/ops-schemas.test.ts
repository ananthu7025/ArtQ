// Ops bodies (task 5.8): notes for closing an exception, filters, and every exception type explained.
import { describe, expect, it } from 'vitest';
import { EXCEPTION_HELP, EXCEPTION_TYPES, exceptionDismissBody, exceptionListQuery, exceptionResolveBody, opsOutboxQuery, reconcileBody } from './ops-schemas.js';

const issues = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) => Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join('.'), i.message]));

describe('ops schemas', () => {
  it('every exception type has a title and an action for staff', () => {
    for (const t of EXCEPTION_TYPES) expect(EXCEPTION_HELP[t].title.length * EXCEPTION_HELP[t].action.length).toBeGreaterThan(0);
  });
  it('resolve / dismiss notes: 3 ok, 2 not; 500 ok, 501 not; unknown keys refused', () => {
    expect(exceptionResolveBody.safeParse({ resolution: 'abc' }).success).toBe(true);
    expect(issues(exceptionResolveBody.safeParse({ resolution: 'ab' }))).toEqual({ resolution: 'Say what you did' });
    expect(issues(exceptionResolveBody.safeParse({}))).toEqual({ resolution: 'Say what you did' });
    expect(exceptionDismissBody.safeParse({ note: 'x'.repeat(500) }).success).toBe(true);
    expect(issues(exceptionDismissBody.safeParse({ note: 'x'.repeat(501) }))).toEqual({ note: 'Use at most 500 characters' });
    expect(exceptionDismissBody.safeParse({ note: 'fine', extra: 1 }).success).toBe(false);
  });
  it('filters and reconcile body', () => {
    expect(exceptionListQuery.parse({ open: '1', type: 'OVERSOLD' })).toEqual({ open: '1', type: 'OVERSOLD', page: 1, limit: 25 });
    expect(exceptionListQuery.safeParse({ type: 'NOPE' }).success).toBe(false);
    expect(opsOutboxQuery.parse({ status: 'STUCK' }).status).toBe('STUCK');
    expect(reconcileBody.parse({})).toEqual({});
    expect(reconcileBody.safeParse({ orderId: 0 }).success).toBe(false);
  });
});
