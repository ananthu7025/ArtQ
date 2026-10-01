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
