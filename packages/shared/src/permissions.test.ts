import { describe, expect, it } from 'vitest';
import { can, isPermission, maskContact, PERMISSIONS, permissionsFor, ROLE_PERMISSIONS, STEP_UP_PERMISSIONS } from './permissions.js';

// architecture.md §5.9, one row per permission: [STAFF, ADMIN, SUPER_ADMIN]
const TABLE: Record<string, [boolean, boolean, boolean]> = {
  'dashboard:read': [true, true, true],
  'orders:read': [true, true, true],
  'orders:fulfil': [true, true, true],
  'orders:cancel': [false, true, true],
  'refunds:create': [false, true, true],
  'returns:receive': [true, true, true],
  'returns:decide': [false, true, true],
  'cod:remit': [false, true, true],
  'inventory:read': [true, true, true],
  'inventory:adjust': [true, true, true],
  'catalog:read': [true, true, true],
  'catalog:write': [false, true, true],
  'pricing:write': [false, true, true],
  'catalog:publish': [false, true, true],
  'imports:catalog': [false, true, true],
  'customers:read': [true, true, true],
  'customers:write': [false, true, true],
  'coupons:write': [false, true, true],
  'shipping:write': [false, true, true],
  'restock:read': [true, true, true],
  'restock:notify': [false, true, true],
  'content:write': [false, true, true],
  'media:write': [false, true, true],
  'payments:exceptions': [false, true, true],
  'jobs:read': [false, true, true],
  'jobs:retry': [false, false, true],
  'settings:write': [false, false, true],
  'staff:manage': [false, false, true],
  'audit:read': [false, false, true],
};

describe('permission map (architecture.md §5.9)', () => {
  it('lists exactly the documented permissions', () => {
    expect([...PERMISSIONS].sort()).toEqual(Object.keys(TABLE).sort());
  });

  it.each(Object.entries(TABLE))('%s → STAFF %s, ADMIN %s, SUPER_ADMIN %s', (perm, [staff, admin, sup]) => {
    if (!isPermission(perm)) throw new Error(perm);
    expect([can('STAFF', perm), can('ADMIN', perm), can('SUPER_ADMIN', perm), can('CUSTOMER', perm)]).toEqual([staff, admin, sup, false]);
  });

  it('roles are strictly nested and have no duplicates', () => {
    const [s, a, sa] = (['STAFF', 'ADMIN', 'SUPER_ADMIN'] as const).map((r) => new Set(ROLE_PERMISSIONS[r]));
    expect([...s!].every((p) => a!.has(p))).toBe(true);
    expect([...a!].every((p) => sa!.has(p))).toBe(true);
    for (const r of ['STAFF', 'ADMIN', 'SUPER_ADMIN'] as const) expect(new Set(ROLE_PERMISSIONS[r]).size).toBe(ROLE_PERMISSIONS[r].length);
    expect(sa!.size).toBe(PERMISSIONS.length);
  });

  it('STAFF can never change prices', () => {
    expect(can('STAFF', 'pricing:write')).toBe(false);
    expect(can('STAFF', 'imports:catalog')).toBe(false);
    expect(can('STAFF', 'catalog:write')).toBe(false);
  });

  it('step-up permissions are refunds, settings and staff management', () => {
    expect([...STEP_UP_PERMISSIONS].sort()).toEqual(['refunds:create', 'settings:write', 'staff:manage']);
  });

  it('permissionsFor returns a copy', () => {
    const p = permissionsFor('STAFF');
    p.push('audit:read');
    expect(can('STAFF', 'audit:read')).toBe(false);
    expect(permissionsFor('CUSTOMER')).toEqual([]);
  });

  it('isPermission', () => {
    expect(isPermission('orders:read')).toBe(true);
    expect(isPermission('orders:delete')).toBe(false);
  });
});

describe('maskContact', () => {
  it.each([
    ['ananthu@gmail.com', 'a***@gmail.com'],
    ['+919876543210', '+********3210'],
    ['9876543210', '******3210'],
    ['98 765 43210', '******3210'],
    ['1234', '****'],
    ['', '****'],
  ])('%j → %j', (input, out) => { expect(maskContact(input)).toBe(out); });
});
