// Staff & Permissions request schemas (api.md §4.10), shared by the API and the admin forms (CLAUDE.md "Validation rule").
import { z } from 'zod';
import { emailField, nameField } from './auth-schemas.js';
import type { StaffRole } from './permissions.js';

export const STAFF_ROLES = ['STAFF', 'ADMIN', 'SUPER_ADMIN'] as const satisfies readonly StaffRole[];
const staffRole = z.enum(STAFF_ROLES, { error: 'Choose a role' });

export const staffListQuery = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().min(1).max(160).optional(),
  role: staffRole.optional(),
  status: z.enum(['ACTIVE', 'BLOCKED']).optional(),
});

export const staffCreateBody = z.strictObject({ email: emailField, name: nameField, role: staffRole });

/** role CUSTOMER removes admin access. */
export const staffUpdateBody = z.strictObject({ name: nameField.optional(), role: z.enum(['CUSTOMER', ...STAFF_ROLES], { error: 'Choose a role' }).optional() })
  .refine((b) => b.name !== undefined || b.role !== undefined, 'Nothing to update');

export type StaffCreate = z.infer<typeof staffCreateBody>;
