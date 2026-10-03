import { permissionsFor } from '@artq/shared';
import { describe, expect, it } from 'vitest';
import { ALL_NAV_ITEMS, NAV, visibleNav } from '../src/nav';

const labels = (role: 'STAFF' | 'ADMIN' | 'SUPER_ADMIN') => visibleNav(permissionsFor(role)).flatMap((g) => g.items.map((i) => i.label));

describe('navigation (product.md §7.2)', () => {
  it('follows the screenshot order, then Operations, Catalogue tools, Content, Admin', () => {
    expect(NAV[0]!.items.map((i) => i.label)).toEqual(['Dashboard', 'Orders', 'Customers', 'Coupons', 'Shipping Rates', 'Products', 'Restock Requests', 'Product Types', 'Categories', 'Techniques']);
    expect(NAV.map((g) => g.title)).toEqual([null, 'Operations', 'Catalogue tools', 'Content', 'Admin']);
    expect(ALL_NAV_ITEMS).toHaveLength(20);   // 21 in product.md §7.2 minus Media (dropped by the owner 2026-10-03)
    expect(new Set(ALL_NAV_ITEMS.map((i) => i.path)).size).toBe(20);
    expect(NAV[2]!.items.map((i) => i.label)).toEqual(['Imports']);
  });

  it('SUPER_ADMIN sees every module', () => { expect(labels('SUPER_ADMIN')).toHaveLength(20); });

  it('ADMIN sees everything except the Admin group items that need super-admin permissions (and job retries)', () => {
    expect(labels('ADMIN')).toEqual(ALL_NAV_ITEMS.map((i) => i.label).filter((l) => !['Staff & Permissions', 'Settings', 'Audit Logs'].includes(l)));
  });

  it('STAFF sees only operational modules; no pricing/catalogue-writing or admin modules', () => {
    expect(labels('STAFF')).toEqual(['Dashboard', 'Orders', 'Customers', 'Products', 'Restock Requests', 'Inventory', 'Returns & Refunds', 'Imports']);
    expect(visibleNav(permissionsFor('STAFF')).map((g) => g.title)).toEqual([null, 'Operations', 'Catalogue tools']);   // empty groups dropped
  });

  it('a customer or an unknown permission set sees nothing', () => {
    expect(visibleNav([])).toEqual([]);
    expect(visibleNav(['nonsense'])).toEqual([]);
  });
});
