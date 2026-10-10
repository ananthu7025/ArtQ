// Admin permissions (architecture.md §5.9). The API enforces them (requirePermission); the admin SPA uses the same map
// only to hide navigation and actions. Each endpoint's request schema accepts only the fields its permission covers.

export const PERMISSIONS = [
  'dashboard:read',
  'orders:read', 'orders:fulfil', 'orders:cancel',
  'refunds:create',
  'returns:receive', 'returns:decide',
  'cod:remit',
  'inventory:read', 'inventory:adjust',
  'catalog:read', 'catalog:write', 'pricing:write', 'catalog:publish',
  'imports:catalog',
  'customers:read', 'customers:write',
  'coupons:write',
  'shipping:write',
  'restock:read', 'restock:notify',
  'content:write',
  'media:write',
  'payments:exceptions',
  'jobs:read', 'jobs:retry',
  'settings:write',
  'staff:manage',
  'audit:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type Role = 'CUSTOMER' | 'STAFF' | 'ADMIN' | 'SUPER_ADMIN';
export type StaffRole = Exclude<Role, 'CUSTOMER'>;

const STAFF: readonly Permission[] = [
  'dashboard:read', 'orders:read', 'orders:fulfil', 'returns:receive', 'inventory:read', 'inventory:adjust',
  'catalog:read', 'customers:read', 'restock:read',
];
const ADMIN: readonly Permission[] = [
  ...STAFF,
  'orders:cancel', 'refunds:create', 'returns:decide', 'cod:remit', 'catalog:write', 'pricing:write', 'catalog:publish',
  'imports:catalog', 'customers:write', 'coupons:write', 'shipping:write', 'restock:notify', 'content:write', 'media:write',
  'payments:exceptions', 'jobs:read',
];
const SUPER_ADMIN: readonly Permission[] = [...ADMIN, 'jobs:retry', 'settings:write', 'staff:manage', 'audit:read'];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  CUSTOMER: [],
  STAFF,
  ADMIN,
  SUPER_ADMIN,
};

/**
 * Permissions whose endpoints also require a recent re-authentication (step-up, architecture.md §5.8): refunds,
 * payment/store settings and staff management. Customer-data exports opt in per endpoint.
 */
export const STEP_UP_PERMISSIONS: readonly Permission[] = ['refunds:create', 'settings:write', 'staff:manage'];

/** What each permission lets someone do, in the owner's words (the Staff & Permissions page). Every permission has one. */
export const PERMISSION_LABEL: Readonly<Record<Permission, string>> = {
  'dashboard:read': 'See the dashboard',
  'orders:read': 'See orders', 'orders:fulfil': 'Confirm, pack and ship orders', 'orders:cancel': 'Cancel orders',
  'refunds:create': 'Refund money (asks for the password)',
  'returns:receive': 'Receive returned parcels', 'returns:decide': 'Approve or reject returns',
  'cod:remit': 'Record COD remittances',
  'inventory:read': 'See stock', 'inventory:adjust': 'Count and adjust stock',
  'catalog:read': 'See products', 'catalog:write': 'Edit products', 'pricing:write': 'Change prices', 'catalog:publish': 'Publish products and approve tax',
  'imports:catalog': 'Import the catalogue',
  'customers:read': 'See customers (contact details masked)', 'customers:write': 'See full contact details, block customers',
  'coupons:write': 'Manage coupons',
  'shipping:write': 'Manage shipping rates and delivery areas',
  'restock:read': 'See back-in-stock requests', 'restock:notify': 'Send back-in-stock emails',
  'content:write': 'Edit the home page, pages, FAQs, newsletter and SEO',
  'media:write': 'Upload images and videos',
  'payments:exceptions': 'Resolve payment problems',
  'jobs:read': 'See jobs and webhooks', 'jobs:retry': 'Retry failed jobs and webhooks',
  'settings:write': 'Change store, payment and tax settings (asks for the password)',
  'staff:manage': 'Add staff and change their access (asks for the password)',
  'audit:read': 'See and export the audit log',
};

/** STAFF see customers with masked contact details (§5.9 "masked contact"). */
export const MASKED_CONTACT_ROLES: readonly Role[] = ['STAFF'];

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsFor(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function isPermission(v: string): v is Permission {
  return (PERMISSIONS as readonly string[]).includes(v);
}

/** "a***@gmail.com" / "+********3210" for roles without full customer contact access. */
export function maskContact(value: string): string {
  const at = value.indexOf('@');
  if (at > 0) return `${value.slice(0, 1)}***${value.slice(at)}`;
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `${value.trim().startsWith('+') ? '+' : ''}${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}
