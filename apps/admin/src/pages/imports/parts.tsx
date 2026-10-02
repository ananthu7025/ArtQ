// Shared pieces of the Imports pages.
export type ImportStatusValue = 'UPLOADED' | 'VALIDATING' | 'VALIDATED' | 'IMPORTING' | 'COMPLETED' | 'COMPLETED_WITH_ERRORS' | 'FAILED' | 'CANCELLED';
export type ImportView = {
  id: number; fileName: string; status: ImportStatusValue; totalRows: number; createdCount: number; updatedCount: number; unchangedCount: number;
  reviewCount: number; failedCount: number; createdAt: string; validatedAt: string | null; completedAt: string | null;
  rows?: Partial<Record<string, number>>; flaggedRows?: number; products?: number;
};
export type ImportRowView = {
  id: number; rowNumber: number; sku: string | null; productKey: string | null; status: string; plan: string; productName: string; size: string | null;
  price: number | null; mrp: number | null; stock: number | string; flags: string[]; messages: { code: string; text: string }[]; productId: number | null;
};

const LABEL: Record<ImportStatusValue, [string, string]> = {
  UPLOADED: ['Waiting to be checked', 'bg-surface-100 text-ink-700'], VALIDATING: ['Checking the file', 'bg-surface-100 text-ink-700'],
  VALIDATED: ['Checked: ready to import', 'bg-brand-50 text-brand-800'], IMPORTING: ['Importing', 'bg-brand-50 text-brand-800'],
  COMPLETED: ['Completed', 'bg-[#dcfce7] text-success-700'], COMPLETED_WITH_ERRORS: ['Completed: some rows need attention', 'bg-warning-bg text-warning-ink'],
  FAILED: ['Failed', 'bg-[#fee2e2] text-danger-700'], CANCELLED: ['Cancelled', 'bg-surface-200 text-ink-700'],
};
export function ImportStatus({ status }: { status: ImportStatusValue }) {
  const [label, cls] = LABEL[status];
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>{label}</span>;
}

/** What each row outcome means for the person reading the list. */
export const OUTCOME: Record<string, string> = {
  PENDING: 'To import', CREATED: 'Created', UPDATED: 'Updated', UNCHANGED: 'No change', SKIPPED: 'Skipped', NEEDS_REVIEW: 'Needs review', FAILED: 'Failed',
};
export const PLAN: Record<string, string> = { create: 'New', update: 'Update', unchanged: 'No change' };

/** Flag codes in plain words (catalog.md §4, §6). */
export const FLAG_LABEL: Record<string, string> = {
  STOCK_AMBIGUOUS: 'Stock not a count', SIZE_CONFLICT: 'Size to confirm', PRICE_MISSING: 'No price', PRICE_REVIEW: 'Price to check', PRICE_CONFLICT: 'Price conflict',
  WEIGHT_ESTIMATED: 'Weight estimated', DESCRIPTION_SUSPECT_COPY: 'Description copied?', COPY_REVIEW: 'Copy to check', COLOUR_REVIEW: 'Colours to confirm',
};
