// Product editor content form (CLAUDE.md "Validation rule"): the inputs are edited in a friendly shape (one list item per
// line, comma-separated tags, key/value rows), converted to the API shape, then validated by the API's own
// `productContent` schema, so every limit and message is the server's.
import { productContent, RELATION_KINDS } from '@artq/shared';
import { z } from 'zod';

const nullIfBlank = z.string().transform((s) => (s.trim() === '' ? null : s));
const lines = z.string().transform((s) => s.split('\n').map((l) => l.trim()).filter(Boolean));
const optionalInt = z.union([z.number(), z.null()]);

export const editorForm = z.object({
  name: z.string(),
  slug: z.string(),
  typeId: z.number().nullable(),
  categoryId: z.number().nullable(),
  techniqueIds: z.array(z.number()),
  shortDescription: nullIfBlank,
  description: nullIfBlank,
  productDetails: lines,
  specificationsCare: lines,
  howToUse: nullIfBlank,
  specifications: z.array(z.object({ key: z.string(), value: z.string() }))
    .transform((rows) => Object.fromEntries(rows.filter((r) => r.key.trim() !== '' || r.value.trim() !== '').map((r) => [r.key.trim(), r.value.trim()]))),
  tags: z.string().transform((s) => s.split(',').map((t) => t.trim()).filter(Boolean)),
  isNewArrival: z.boolean(),
  newArrivalRank: optionalInt,
  isTrending: z.boolean(),
  trendingRank: optionalInt,
  isFeatured: z.boolean(),
  sortOrder: z.number(),
  metaTitle: nullIfBlank,
  metaDescription: nullIfBlank,
  dataFlags: z.array(z.string()),
  relations: z.array(z.object({ productId: z.number(), kind: z.enum(RELATION_KINDS), name: z.string() }))
    .transform((rs) => rs.map(({ productId, kind }) => ({ productId, kind }))),
  // z.any() bridges the converted object into the API schema (TypeScript cannot relate the two structural types; the
  // API schema does the real checking at run time and defines the output type).
}).pipe(z.any()).pipe(productContent);

export type EditorFormIn = z.input<typeof editorForm>;
export type EditorFormOut = z.output<typeof editorForm>;

export type ProductPayload = {
  id: number; status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'; name: string; slug: string; shortDescription: string | null; description: string | null;
  productDetails: string[]; specificationsCare: string[]; howToUse: string | null; specifications: Record<string, string>; tags: string[];
  type: { id: number; name: string } | null; category: { id: number; name: string } | null; techniqueIds: number[];
  hsnCode: string | null; gstRate: number | null; taxApprovedAt: string | null;
  isNewArrival: boolean; newArrivalRank: number | null; isTrending: boolean; trendingRank: number | null; isFeatured: boolean; sortOrder: number;
  metaTitle: string | null; metaDescription: string | null; dataFlags: string[];
  aggregates: { minPrice: number | null; maxPrice: number | null; maxMrp: number | null; available: number; activeVariants: number };
  variants: EditorVariant[];
  images: { id: number; mediaId: number; alt: string | null; sortOrder: number; isCover: boolean; media: { id: number; status: string; renditions?: Record<string, string>; failureReason?: string | null } }[];
  relations: { productId: number; kind: (typeof RELATION_KINDS)[number]; name: string; slug: string; status: string }[];
  readiness: { ready: boolean; failures: { code: string; check: string; fix: string }[] };
  version: number; updatedAt: string; updatedBy: { id: number; name: string | null; email: string } | null;
};

export type EditorVariant = {
  id: number; sku: string; label: string; size: string | null; netQuantity: number | null; netUnit: string | null; color: string | null; colorHex: string | null;
  thickness: string | null; weightG: number | null; weightSource: 'MEASURED' | 'ESTIMATED' | null; lengthCm: number | null; widthCm: number | null; heightCm: number | null;
  shippingClass: 'STANDARD' | 'BULKY' | 'SURFACE_ONLY'; imageMediaId: number | null; barcode: string | null; sortOrder: number; isActive: boolean;
  price: number | null; mrp: number | null; costPrice?: number | null; onHand: number; reserved: number; available: number; dataFlags: string[]; version: number;
};

/** Product payload → form values. */
export function toForm(p: ProductPayload): EditorFormIn {
  return {
    name: p.name, slug: p.slug, typeId: p.type?.id ?? null, categoryId: p.category?.id ?? null, techniqueIds: p.techniqueIds,
    shortDescription: p.shortDescription ?? '', description: p.description ?? '', productDetails: p.productDetails.join('\n'),
    specificationsCare: p.specificationsCare.join('\n'), howToUse: p.howToUse ?? '',
    specifications: Object.entries(p.specifications).map(([key, value]) => ({ key, value })),
    tags: p.tags.join(', '), isNewArrival: p.isNewArrival, newArrivalRank: p.newArrivalRank, isTrending: p.isTrending, trendingRank: p.trendingRank,
    isFeatured: p.isFeatured, sortOrder: p.sortOrder, metaTitle: p.metaTitle ?? '', metaDescription: p.metaDescription ?? '', dataFlags: p.dataFlags,
    relations: p.relations.map((r) => ({ productId: r.productId, kind: r.kind, name: r.name })),
  };
}

/** Human field names for the version-conflict comparison. */
export const FIELD_LABELS: Record<keyof EditorFormIn, string> = {
  name: 'Name', slug: 'URL slug', typeId: 'Product type', categoryId: 'Category', techniqueIds: 'Techniques', shortDescription: 'Short description',
  description: 'Description', productDetails: 'Product details', specificationsCare: 'Specifications & care', howToUse: 'How to use',
  specifications: 'Specifications', tags: 'Tags', isNewArrival: 'New arrival', newArrivalRank: 'New arrival rank', isTrending: 'Trending',
  trendingRank: 'Trending rank', isFeatured: 'Featured', sortOrder: 'Sort order', metaTitle: 'SEO title', metaDescription: 'SEO description',
  dataFlags: 'Import flags', relations: 'Related products',
};
