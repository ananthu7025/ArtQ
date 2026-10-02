// Catalogue request schemas (api.md §4.3), one per permission (architecture.md §5.9: each endpoint accepts only the
// fields its permission covers). Shared by the API and the admin editor forms (CLAUDE.md "Validation rule"). Content schemas have NO price, cost or stock fields: those are refused as unknown keys (AT-10).
import { z } from 'zod';

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => text(max).nullable().optional();
const list = (items: number, len: number) => z.array(text(len).min(1)).max(items);
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const id = z.number().int().positive();
const flags = z.array(z.string().regex(/^[A-Z_]{3,40}$/)).max(20);
const dim = z.number().positive().max(9999.9).multipleOf(0.1).nullable().optional();

export const productContent = z.strictObject({
  name: text(200).min(1),
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
  sku: z.string().trim().toUpperCase().max(64).regex(/^[A-Z0-9][A-Z0-9._-]*$/, 'letters, digits, . _ -'),
  label: text(160).min(1),
  size: optText(60),
  netQuantity: z.number().positive().max(1_000_000).nullable().optional(),
  netUnit: z.enum(['G', 'KG', 'ML', 'PCS', 'IN']).nullable().optional(),
  color: optText(60),
  colorHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  thickness: optText(40),
  weightG: z.number().int().positive().max(100_000).nullable().optional(),
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
  price: z.number().int().positive().max(100_000_000),
  mrp: z.number().int().positive().max(100_000_000).nullable(),
  costPrice: z.number().int().min(0).max(100_000_000).nullable().optional(),
  version: z.number().int().positive(),
}).refine((b) => b.mrp === null || b.mrp >= b.price, { message: 'MRP must be at least the price', path: ['mrp'] });

/** Bulk content actions (catalog:write). Publish / unpublish / archive arrive with the publication gate (task 2.3). */
export const bulkBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.enum(['markNew', 'unmarkNew', 'markTrending', 'unmarkTrending']), ids: z.array(id).min(1).max(100) }),
  z.strictObject({ action: z.literal('setType'), ids: z.array(id).min(1).max(100), typeId: id }),
  z.strictObject({ action: z.literal('setCategory'), ids: z.array(id).min(1).max(100), categoryId: id }),
]);

export const idParam = z.strictObject({ id: z.coerce.number().int().positive() });

export type CreateProduct = z.infer<typeof createProductBody>;
export type UpdateProduct = z.infer<typeof updateProductBody>;
export type CreateVariant = z.infer<typeof createVariantBody>;
export type UpdateVariant = z.infer<typeof updateVariantBody>;
export type Pricing = z.infer<typeof pricingBody>;
export type Bulk = z.infer<typeof bulkBody>;
