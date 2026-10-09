// Dashboard, Customers and Restock Requests in the admin (task 5.9; api.md §4.2 and §4.8, product.md §7.5).
// Shared by the API and the admin (validation rule). Money in paise; days are India calendar days.
import { z } from 'zod';

export const DASHBOARD_RANGES = ['today', '7d', '30d'] as const;
export const dashboardQuery = z.strictObject({ range: z.enum(DASHBOARD_RANGES).default('7d') });

export type Dashboard = {
  range: (typeof DASHBOARD_RANGES)[number];
  /** Placed orders (not cancelled) in the range; revenue is after refunds. */
  revenue: number; orders: number; aov: number; newCustomers: number;
  /** Hourly for today, daily otherwise (India time); `label` is the hour ("14:00") or the day ("2026-10-09"). */
  salesSeries: { label: string; revenue: number; orders: number }[];
  /** Orders placed in the range by lifecycle status. */
  ordersByStatus: Record<string, number>;
  pendingActions: { toConfirm: number; toPack: number; toShip: number; returnsToDecide: number; openExceptions: number; restockRequests: number; codOverdue: number; messages: number };
  lowStock: { variantId: number; productId: number; productName: string; label: string; sku: string; available: number; threshold: number }[];
  topProducts: { productId: number | null; name: string; units: number; revenue: number }[];
};

export const customerListQuery = z.strictObject({
  q: z.string().trim().min(1).max(100, 'Use at most 100 characters').optional(),
  status: z.enum(['ACTIVE', 'BLOCKED', 'PENDING_VERIFICATION']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const CUSTOMER_NOTES_MAX = 2000;
/** PATCH /admin/customers/:id [customers:write]: the staff note (empty clears it). */
export const customerPatchBody = z.strictObject({
  adminNotes: z.string().trim().max(CUSTOMER_NOTES_MAX, `Use at most ${CUSTOMER_NOTES_MAX.toLocaleString('en-IN')} characters`).transform((v) => v || null).nullable(),
});
/** POST /admin/customers/:id/block: why (kept in the audit log). */
export const customerBlockBody = z.strictObject({
  reason: z.string({ error: 'Say why you are blocking this customer' }).trim().min(3, 'Say why you are blocking this customer').max(300, 'Use at most 300 characters'),
});

export type AdminCustomerRow = {
  id: number; name: string | null; email: string; phone: string | null; status: string; emailVerified: boolean;
  orders: number; spent: number; createdAt: string; lastLoginAt: string | null;
};
export type AdminCustomerDetail = AdminCustomerRow & {
  contactMasked: boolean; marketingOptIn: boolean; adminNotes: string | null; wishlistCount: number;
  addresses: { id: number; label: string; fullName: string; lines: string[]; phone: string; isDefault: boolean }[];
  recentOrders: { id: number; orderNumber: string; createdAt: string; total: number; status: string; paymentStatus: string; fulfilmentStatus: string }[];
};

export const restockListQuery = z.strictObject({
  /** Only variants that can be notified now (available > 0). */
  available: z.literal('1').optional(),
  q: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const restockNotifyBody = z.strictObject({ variantId: z.number().int().positive() });

export type RestockGroup = {
  variantId: number; sku: string; label: string; product: { id: number; name: string; status: string };
  pending: number; oldestAt: string; available: number; notifiedToday: boolean;
};
export type RestockRequestRow = { id: number; email: string; customerId: number | null; createdAt: string };
