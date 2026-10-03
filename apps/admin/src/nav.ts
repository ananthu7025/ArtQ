// Admin navigation (product.md §7.2): the order of the provided screenshot, then the modules this plan adds.
// Visibility is a UI convenience only; every endpoint enforces its own permission.
import type { Permission } from '@artq/shared';

export type NavItem = {
  label: string;
  path: string;
  /** Any one of these permissions shows the item. */
  perms: Permission[];
  /** Task that builds the module (shown on its placeholder page until then). */
  task: string;
};
export type NavGroup = { title: string | null; items: NavItem[] };

export const NAV: NavGroup[] = [
  { title: null, items: [
    { label: 'Dashboard', path: '/dashboard', perms: ['dashboard:read'], task: '5.9' },
    { label: 'Orders', path: '/orders', perms: ['orders:read'], task: '5.1' },
    { label: 'Customers', path: '/customers', perms: ['customers:read'], task: '5.9' },
    { label: 'Coupons', path: '/coupons', perms: ['coupons:write'], task: '4.3' },
    { label: 'Shipping Rates', path: '/shipping-rates', perms: ['shipping:write'], task: '4.4' },
    { label: 'Products', path: '/products', perms: ['catalog:read'], task: '2.4' },
    { label: 'Restock Requests', path: '/restock-requests', perms: ['restock:read'], task: '5.9' },
    { label: 'Product Types', path: '/product-types', perms: ['catalog:write'], task: '2.6' },
    { label: 'Categories', path: '/categories', perms: ['catalog:write'], task: '2.6' },
    { label: 'Techniques', path: '/techniques', perms: ['catalog:write'], task: '2.6' },
  ] },
  { title: 'Operations', items: [
    { label: 'Inventory', path: '/inventory', perms: ['inventory:read'], task: '2.8' },
    { label: 'Returns & Refunds', path: '/returns', perms: ['returns:receive', 'refunds:create'], task: '5.4 / 5.5' },
    { label: 'COD Remittances', path: '/cod-remittances', perms: ['cod:remit'], task: '5.6' },
    { label: 'Payment Exceptions', path: '/payment-exceptions', perms: ['payments:exceptions'], task: '5.8' },
    { label: 'Jobs & Webhooks', path: '/jobs', perms: ['jobs:read'], task: '5.8' },
  ] },
  { title: 'Catalogue tools', items: [
    { label: 'Imports', path: '/imports', perms: ['imports:catalog', 'inventory:adjust'], task: '2.7' },
  ] },
  { title: 'Content', items: [
    { label: 'CMS & Messages', path: '/cms', perms: ['content:write'], task: '6.1' },
  ] },
  { title: 'Admin', items: [
    { label: 'Staff & Permissions', path: '/staff', perms: ['staff:manage'], task: '1.12' },
    { label: 'Settings', path: '/settings', perms: ['settings:write'], task: '6.5' },
    { label: 'Audit Logs', path: '/audit-logs', perms: ['audit:read'], task: '6.5' },
  ] },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);

/** Groups and items the user may see; empty groups are dropped. */
export function visibleNav(permissions: readonly string[]): NavGroup[] {
  const has = new Set(permissions);
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => i.perms.some((p) => has.has(p))) })).filter((g) => g.items.length > 0);
}

export function canSee(item: NavItem, permissions: readonly string[]): boolean {
  return item.perms.some((p) => permissions.includes(p));
}
