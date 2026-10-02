// Catalogue and inventory import requests (api.md §4.9 "Imports"), shared by the API and the Imports page (CLAUDE.md "Validation rule").
import { z } from 'zod';

export const IMPORT_ROW_STATUSES = ['PENDING', 'CREATED', 'UPDATED', 'UNCHANGED', 'SKIPPED', 'NEEDS_REVIEW', 'FAILED'] as const;

export const createImportBody = z.strictObject({
  /** CATALOG (imports:catalog) or INVENTORY counts (inventory:adjust, on-hand only). */
  kind: z.enum(['CATALOG', 'INVENTORY'], { error: 'Choose a catalogue or an inventory import' }),
  fileMediaId: z.number({ error: 'Upload the .xlsx file first' }).int().positive(),
  /** The name of the file as the person chose it (shown in the import list). */
  fileName: z.string().trim().min(1).max(200).optional(),
  /** Create product types, categories (and techniques) named in the file that do not exist yet. */
  createMissing: z.boolean().default(false),
});
export const importListQuery = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const importRowsQuery = z.strictObject({
  status: z.enum(IMPORT_ROW_STATUSES).optional(),
  flagged: z.enum(['1']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const resolveImportRowBody = z.strictObject({ action: z.enum(['apply', 'skip'], { error: 'Choose apply or skip' }) });
