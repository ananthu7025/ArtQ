// Database constraint violations → clear API errors (instead of 500s). Shapes verified on Prisma 6.19.3 / PG 16.
import { AppError } from '../lib/errors.js';

type PrismaLike = { code?: string; meta?: { target?: unknown; constraint?: unknown; modelName?: unknown }; message?: string };

const CHECKS: Record<string, [number, string, string]> = {
  variants_mrp_ck: [422, 'MRP_BELOW_PRICE', 'MRP must be at least the price'],
  variants_price_ck: [422, 'VALIDATION_ERROR', 'Price must be positive'],
  variants_dims_ck: [422, 'DIMENSIONS_INCOMPLETE', 'Give length, width and height together (all positive), or none'],
  variants_hex_ck: [422, 'VALIDATION_ERROR', 'Colour must be a hex code like #d4af37'],
  variants_weight_ck: [422, 'VALIDATION_ERROR', 'Weight must be positive'],
  // A live product must keep type, category, tax and publication data (database backstop of the edit-guard).
  products_active_gate_ck: [409, 'UNPUBLISH_FIRST', 'A live product needs its type, category and approved tax. Unpublish it first.'],
};

/** Returns an AppError for a known constraint violation, or undefined. */
export function catalogConstraintError(e: unknown): AppError | undefined {
  const p = e as PrismaLike;
  if (p?.code === 'P2002') {
    const target = JSON.stringify(p.meta?.target ?? '');
    if (p.meta?.modelName === 'ProductVariant' && target.includes('"sku"')) return new AppError(409, 'SKU_EXISTS', 'Another variant already uses this SKU');
    if (p.meta?.modelName === 'ProductVariant' && target.includes('product_id')) return new AppError(409, 'VARIANT_OPTIONS_EXIST', 'This product already has a variant with the same size, colour and thickness');
    if (p.meta?.modelName === 'Product' && target.includes('slug')) return new AppError(409, 'SLUG_TAKEN', 'Another product already uses this URL slug');
  }
  if (p?.code === 'P2003') {
    const c = String(p.meta?.constraint ?? '');
    if (c === 'products_category_matches_type_fk') return new AppError(422, 'CATEGORY_TYPE_MISMATCH', 'The category does not belong to the chosen product type');
    if (/media|image/.test(c)) return new AppError(422, 'MEDIA_NOT_FOUND', 'The image does not exist');
    if (/type_id|category_id|technique_id/.test(c)) return new AppError(422, 'TAXONOMY_NOT_FOUND', 'The product type, category or technique does not exist');
  }
  const msg = p?.message ?? '';
  for (const [name, [status, code, text]] of Object.entries(CHECKS)) if (msg.includes(name)) return new AppError(status, code, text);
  return undefined;
}

export function rethrowCatalog(e: unknown): never {
  throw catalogConstraintError(e) ?? e;
}
