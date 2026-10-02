// Product types, categories and techniques (api.md §4.4), shared by the API and the admin forms (CLAUDE.md "Validation
// rule"). Create = name required, the rest optional (slug derived from the name); update = any subset, at least one field.
import { z } from 'zod';
import { SLUG } from './catalog-schemas.js';

const text = (max: number) => z.string().trim().max(max, `Use at most ${max} characters`);
const name = (max: number) => text(max).min(1, 'Enter a name');
const slug = (max: number) => z.string().trim().max(max, `Use at most ${max} characters`).regex(SLUG, 'Use lowercase letters, digits and single hyphens, e.g. epoxy-resin');
const optional = (max: number) => text(max).nullable();
const mediaId = z.number().int().positive().nullable();
const sortOrder = z.number({ error: 'Enter a number' }).int('Use a whole number').min(-100_000).max(100_000);
const seo = { metaTitle: optional(160), metaDescription: optional(320) };

export const productTypeContent = z.strictObject({
  name: name(80), slug: slug(100), description: optional(2000), imageMediaId: mediaId, bannerMediaId: mediaId,
  tileLinkUrl: z.string().trim().max(300, 'Use at most 300 characters').regex(/^(\/\S*|https:\/\/\S+)$/, 'Use a path like /category/epoxy-resin or an https:// address').nullable(),
  sortOrder, isActive: z.boolean(), showOnHome: z.boolean(), showInMenu: z.boolean(), ...seo,
});

export const categoryContent = z.strictObject({
  typeId: z.number({ error: 'Choose a product type' }).int().positive(), name: name(100), slug: slug(120), description: optional(2000),
  imageMediaId: mediaId,
  defaultHsnCode: z.string().trim().regex(/^(\d{4}|\d{6}|\d{8})$/, 'Enter an HSN code of 4, 6 or 8 digits').nullable(),
  defaultGstRate: z.number({ error: 'Enter the GST rate' }).min(0, 'GST rate cannot be negative').max(40, 'GST rate cannot be more than 40 %')
    .refine((r) => Math.abs(r * 100 - Math.round(r * 100)) < 1e-9, 'Use at most two decimals').nullable(),
  sortOrder, isActive: z.boolean(), ...seo,
});

export const techniqueContent = z.strictObject({
  name: name(100), slug: slug(120), description: optional(2000), imageMediaId: mediaId, heroMediaId: mediaId, sortOrder, isActive: z.boolean(), ...seo,
});

const nonEmpty = (o: object) => Object.keys(o).length > 0;
export const createProductTypeBody = productTypeContent.partial().extend({ name: productTypeContent.shape.name });
export const updateProductTypeBody = productTypeContent.partial().refine(nonEmpty, 'Nothing to update');
export const createCategoryBody = categoryContent.partial().extend({ name: categoryContent.shape.name, typeId: categoryContent.shape.typeId });
export const updateCategoryBody = categoryContent.partial().refine(nonEmpty, 'Nothing to update');
export const createTechniqueBody = techniqueContent.partial().extend({ name: techniqueContent.shape.name });
export const updateTechniqueBody = techniqueContent.partial().refine(nonEmpty, 'Nothing to update');

/** New order: every id of the list, first = sort order 0. */
export const reorderBody = z.strictObject({
  ids: z.array(z.number().int().positive()).min(1).max(500).refine((ids) => new Set(ids).size === ids.length, 'An item is listed twice'),
});

export type CreateProductType = z.infer<typeof createProductTypeBody>;
export type UpdateProductType = z.infer<typeof updateProductTypeBody>;
export type CreateCategory = z.infer<typeof createCategoryBody>;
export type UpdateCategory = z.infer<typeof updateCategoryBody>;
export type CreateTechnique = z.infer<typeof createTechniqueBody>;
export type UpdateTechnique = z.infer<typeof updateTechniqueBody>;
