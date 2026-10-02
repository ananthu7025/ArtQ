// Catalogue request schemas (api.md §4.3), one per permission (architecture.md §5.9: each endpoint accepts only the
// fields its permission covers). Shared by the API and the admin editor forms (CLAUDE.md "Validation rule"). Content schemas have NO price, cost or stock fields: those are refused as unknown keys (AT-10).
import { z } from 'zod';
import { READINESS } from './readiness.js';

const text = (max: number) => z.string().trim().max(max, `Use at most ${max} characters`);
const optText = (max: number) => text(max).nullable().optional();
const list = (items: number, len: number) => z.array(text(len).min(1, 'Remove empty lines')).max(items, `At most ${items} items`);
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const id = z.number().int().positive();
const flags = z.array(z.string().regex(/^[A-Z_]{3,40}$/)).max(20);
const dim = z.number({ error: 'Enter a number' }).positive('Must be more than 0').max(9999.9, 'At most 9999.9 cm').multipleOf(0.1, 'Use at most one decimal').nullable().optional();

export const productContent = z.strictObject({
  name: text(200).min(1, 'Enter a product name'),
  slug: z.string().trim().max(220).regex(SLUG, 'lowercase letters, digits and single hyphens'),
  shortDescription: optText(300),
  description: optText(20_000),
  productDetails: list(30, 300),
  specificationsCare: list(30, 300),
  howToUse: optText(5000),
  specifications: z.record(text(80).min(1), text(300)).refine((o) => Object.keys(o).length <= 50, 'at most 50 entries'),
  tags: list(30, 40),
  typeId: id.nullable(),
  categoryId: id.nullable(),
  techniqueIds: z.array(id).max(20),
  isNewArrival: z.boolean(),
  newArrivalRank: z.number().int().min(0).nullable(),
  isTrending: z.boolean(),
  trendingRank: z.number().int().min(0).nullable(),
  isFeatured: z.boolean(),
  sortOrder: z.number().int(),
  metaTitle: optText(160),
  metaDescription: optText(320),
  /** Import flags the admin has resolved (the list that remains). */
  dataFlags: flags,
});

export const variantContent = z.strictObject({
  sku: z.string().trim().toUpperCase().max(64, 'Use at most 64 characters').regex(/^[A-Z0-9][A-Z0-9._-]*$/, 'Use letters, digits, dots, dashes and underscores'),
  label: text(160).min(1, 'Enter a label'),
  size: optText(60),
  netQuantity: z.number().positive().max(1_000_000).nullable().optional(),
  netUnit: z.enum(['G', 'KG', 'ML', 'PCS', 'IN']).nullable().optional(),
  color: optText(60),
  colorHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use a hex colour like #D4AF37').nullable().optional(),
  thickness: optText(40),
  weightG: z.number({ error: 'Enter the weight in grams' }).int('Use whole grams').positive('Must be more than 0 g').max(100_000, 'At most 100,000 g').nullable().optional(),
  weightSource: z.enum(['MEASURED', 'ESTIMATED']).nullable().optional(),
  lengthCm: dim,
  widthCm: dim,
  heightCm: dim,
  shippingClass: z.enum(['STANDARD', 'BULKY', 'SURFACE_ONLY']),
  imageMediaId: id.nullable().optional(),
  barcode: optText(64),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  lowStockThreshold: z.number().int().min(0).max(100_000),
  dataFlags: flags,
});

/** Import flags come only from imports; an admin can resolve (remove) them, never add them. */
export const createVariantBody = variantContent.omit({ dataFlags: true }).partial();
export const updateVariantBody = variantContent.partial().extend({ version: z.number().int().positive() })
  .refine((b) => Object.keys(b).length > 1, 'nothing to update');

export const createProductBody = productContent.omit({ dataFlags: true }).partial().extend({
  name: productContent.shape.name,
  variants: z.array(createVariantBody).max(50).optional(),
});
export const updateProductBody = productContent.partial().extend({ version: z.number().int().positive() })
  .refine((b) => Object.keys(b).length > 1, 'nothing to update');

/** pricing:write only. Paise. MRP ≥ price is also a database check. */
export const pricingBody = z.strictObject({
  price: z.number({ error: 'Enter a price' }).int('Use whole paise').positive('The price must be more than ₹0').max(100_000_000, 'At most ₹10,00,000'),
  mrp: z.number({ error: 'Enter an MRP or leave it empty' }).int('Use whole paise').positive('The MRP must be more than ₹0').max(100_000_000, 'At most ₹10,00,000').nullable(),
  costPrice: z.number({ error: 'Enter a cost or leave it empty' }).int('Use whole paise').min(0, 'The cost cannot be negative').max(100_000_000, 'At most ₹10,00,000').nullable().optional(),
  version: z.number().int().positive(),
}).refine((b) => b.mrp === null || b.mrp >= b.price, { message: 'MRP must be at least the price', path: ['mrp'] });

/** Bulk actions: content (catalog:write) and publication (catalog:publish), each with a per-item result. */
export const BULK_PUBLISH_ACTIONS = ['publish', 'unpublish', 'archive'] as const;
export const bulkBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.enum(['markNew', 'unmarkNew', 'markTrending', 'unmarkTrending']), ids: z.array(id).min(1).max(100) }),
  z.strictObject({ action: z.enum(BULK_PUBLISH_ACTIONS), ids: z.array(id).min(1).max(100) }),
  z.strictObject({ action: z.literal('setType'), ids: z.array(id).min(1).max(100), typeId: id }),
  z.strictObject({ action: z.literal('setCategory'), ids: z.array(id).min(1).max(100), categoryId: id }),
]);

/** Tax approval (catalog:publish). HSN: 4, 6 or 8 digits. GST %: the accountant's rate (D-1); the database allows 0–40. */
export const taxApprovalBody = z.strictObject({
  hsnCode: z.string().trim().regex(/^(\d{4}|\d{6}|\d{8})$/, 'Enter an HSN code of 4, 6 or 8 digits'),
  gstRate: z.number({ error: 'Enter the GST rate' }).min(0, 'GST rate cannot be negative').max(40, 'GST rate cannot be more than 40 %')
    .refine((r) => Math.abs(r * 100 - Math.round(r * 100)) < 1e-9, 'Use at most two decimals'),
});

export const idParam = z.strictObject({ id: z.coerce.number().int().positive() });

export type CreateProduct = z.infer<typeof createProductBody>;
export type UpdateProduct = z.infer<typeof updateProductBody>;
export type CreateVariant = z.infer<typeof createVariantBody>;
export type UpdateVariant = z.infer<typeof updateVariantBody>;
export type Pricing = z.infer<typeof pricingBody>;
export type Bulk = z.infer<typeof bulkBody>;
export type TaxApproval = z.infer<typeof taxApprovalBody>;

// ── Products list (GET /admin/products, api.md §4.3) ──────────────────────
export const PRODUCT_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export const STOCK_FILTERS = ['in', 'low', 'out', 'oversold'] as const;
export const IMAGE_STATES = ['ready', 'processing', 'failed', 'missing'] as const;
export const PRODUCT_SORTS = ['updated_desc', 'name', 'price', 'stock'] as const;
/** `ready`, `blocked`, or one failing check (the codes of product_readiness_failures()). */
export const READINESS_FILTERS = ['ready', 'blocked', ...(Object.keys(READINESS) as (keyof typeof READINESS)[])] as const;

const csv = <T extends string>(values: readonly [T, ...T[]]) => z.preprocess(
  (v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v),
  z.array(z.enum(values)).min(1).max(values.length),
);

export const productListQuery = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  type: z.union([z.literal('unassigned'), z.coerce.number().int().positive()]).optional(),
  status: csv(PRODUCT_STATUSES).optional(),
  stock: z.enum(STOCK_FILTERS).optional(),
  readiness: z.enum(READINESS_FILTERS as unknown as [string, ...string[]]).optional(),
  imageState: z.enum(IMAGE_STATES).optional(),
  flag: z.string().regex(/^[A-Z_]{3,40}$/).optional(),
  sort: z.enum(PRODUCT_SORTS).default('updated_desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ProductListQuery = z.infer<typeof productListQuery>;

export type ImageState = 'READY' | 'PROCESSING' | 'FAILED' | 'MISSING';
/** Row of the Products page (api.md §4.3). `type: null` = a genuinely unassigned draft, shown as "Unassigned". */
export type ProductListRow = {
  serial: number; id: number; name: string; slug: string;
  image: { state: ImageState; url: string | null };
  type: { id: number; name: string } | null; category: { id: number; name: string } | null;
  status: (typeof PRODUCT_STATUSES)[number]; isPublishable: boolean; readinessFailures: string[];
  variantCount: number; activeVariantCount: number; priceRange: { min: number; max: number } | null; available: number;
  lowStock: boolean; oversold: boolean; flags: string[]; deletable: boolean; updatedAt: string; version: number;
};

export const productTypesQuery = z.strictObject({ withCounts: z.enum(['0', '1']).optional() });
export const categoriesQuery = z.strictObject({ typeId: z.coerce.number().int().positive().optional() });
