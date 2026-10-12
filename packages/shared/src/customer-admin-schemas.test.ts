// Dashboard, Customers and Restock bodies (task 5.9).
import { describe, expect, it } from 'vitest';
import { customerBlockBody, customerListQuery, customerPatchBody, dashboardQuery, restockListQuery, restockNotifyBody } from './customer-admin-schemas.js';

const issues = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) => Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join('.'), i.message]));

describe('customer admin schemas', () => {
  it('dashboard range defaults to 7 days; only the three ranges', () => {
    expect(dashboardQuery.parse({})).toEqual({ range: '7d' });
    expect(dashboardQuery.safeParse({ range: '90d' }).success).toBe(false);
  });
  it('staff note: 2,000 ok, 2,001 not; empty clears', () => {
    expect(customerPatchBody.parse({ adminNotes: 'x'.repeat(2000) }).adminNotes).toHaveLength(2000);
    expect(issues(customerPatchBody.safeParse({ adminNotes: 'x'.repeat(2001) }))).toEqual({ adminNotes: 'Use at most 2,000 characters' });
    expect(customerPatchBody.parse({ adminNotes: '   ' })).toEqual({ adminNotes: null });
    expect(customerPatchBody.safeParse({}).success).toBe(false);
  });
  it('block reason: 3 ok, 2 not; 300 ok, 301 not', () => {
    expect(customerBlockBody.safeParse({ reason: 'abc' }).success).toBe(true);
    expect(issues(customerBlockBody.safeParse({ reason: 'ab' }))).toEqual({ reason: 'Say why you are blocking this customer' });
    expect(customerBlockBody.safeParse({ reason: 'x'.repeat(300) }).success).toBe(true);
    expect(issues(customerBlockBody.safeParse({ reason: 'x'.repeat(301) }))).toEqual({ reason: 'Use at most 300 characters' });
  });
  it('list and restock queries', () => {
    expect(customerListQuery.parse({ q: ' hema ', page: '2' })).toEqual({ q: 'hema', page: 2, limit: 25 });
    expect(customerListQuery.safeParse({ status: 'DELETED' }).success).toBe(false);
    expect(customerListQuery.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
    expect(restockListQuery.parse({ available: '1' })).toEqual({ available: '1', page: 1, limit: 25 });
    expect(restockNotifyBody.safeParse({ variantId: 0 }).success).toBe(false);
  });
});
