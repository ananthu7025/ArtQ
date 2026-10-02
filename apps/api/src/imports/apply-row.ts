// Catalogue import, applying one planned row inside a batch transaction (database.md §9).
//   • Products are created as DRAFT and never change status; a live product that an update would make unready is not
//     touched (NEEDS_REVIEW). Existing products/variants changed since validation are not overwritten (NEEDS_REVIEW).
//   • New variants get their initial stock through aq_import_initial_stock (uncounted); existing stock is never changed.
//   • Re-imports never clear a stored weight when the file has none (estimates are not written back to the file).
import { uniqueSlug } from '@artq/shared';
import type { Db } from '../db/functions.js';
import * as fn from '../db/functions.js';
import { AppError } from '../lib/errors.js';
import type { RowPayload } from './plan.js';
import type { Message } from './rows.js';
import { CATALOG_STRUCTURE, TECHNIQUES } from './sheet1-profile.js';

export type RowOutcome = { status: 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'NEEDS_REVIEW'; productId: number | null; variantId: number | null; messages: Message[] };
export type ApplyContext = { importId: number; actorId: number | null; images: Map<string, number>; touched: Set<number>; force?: boolean };

const ci = (s: string) => s.trim().toLowerCase();

async function typeId(db: Db, name: string | null, create: boolean, messages: Message[]): Promise<number | null> {
  if (!name) return null;
  const found = await db.productType.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
  if (found) return found.id;
  if (!create) { messages.push({ code: 'TYPE_UNKNOWN', text: `Product type “${name}” does not exist: imported as Unassigned` }); return null; }
  const known = CATALOG_STRUCTURE.find((t) => ci(t.type) === ci(name));
  const taken = new Set((await db.productType.findMany({ select: { slug: true } })).map((t) => t.slug));
  const slug = known && !taken.has(known.slug) ? known.slug : uniqueSlug(name, (s) => taken.has(s), 100);
  const order = known ? CATALOG_STRUCTURE.indexOf(known) : 100;
  messages.push({ code: 'TYPE_CREATED', text: `Product type “${name}” created` });
  return (await db.productType.create({ data: { name, slug, sortOrder: order }, select: { id: true } })).id;
}

async function categoryId(db: Db, type: number | null, name: string | null, create: boolean, messages: Message[]): Promise<number | null> {
  if (type === null || !name) return null;
  const found = await db.category.findFirst({ where: { typeId: type, name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
  if (found) return found.id;
  if (!create) { messages.push({ code: 'CATEGORY_UNKNOWN', text: `Category “${name}” does not exist in this type: imported without a category` }); return null; }
  const known = CATALOG_STRUCTURE.flatMap((t) => t.categories).find((c) => ci(c.name) === ci(name));
  const taken = new Set((await db.category.findMany({ select: { slug: true } })).map((c) => c.slug));
  const slug = known && !taken.has(known.slug) ? known.slug : uniqueSlug(name, (s) => taken.has(s), 120);
  messages.push({ code: 'CATEGORY_CREATED', text: `Category “${name}” created` });
  return (await db.category.create({ data: { typeId: type, name, slug }, select: { id: true } })).id;
}

/** Techniques are created when missing (database.md §9). */
async function techniqueIds(db: Db, names: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const name of names) {
    const found = await db.technique.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
    if (found) { ids.push(found.id); continue; }
    const taken = new Set((await db.technique.findMany({ select: { slug: true } })).map((t) => t.slug));
    const slug = TECHNIQUES[name] && !taken.has(TECHNIQUES[name]!) ? TECHNIQUES[name]! : uniqueSlug(name, (s) => taken.has(s), 120);
    ids.push((await db.technique.create({ data: { name, slug }, select: { id: true } })).id);
  }
  return ids;
}

const review = (text: string, messages: Message[]): RowOutcome => ({ status: 'NEEDS_REVIEW', productId: null, variantId: null, messages: [...messages, { code: 'CHANGED_SINCE_VALIDATION', text }] });

export async function applyRow(db: Db, payload: RowPayload, ctx: ApplyContext): Promise<RowOutcome> {
  const { row, plan } = payload;
  const messages: Message[] = [];
  const p = row.product, v = row.variant;

  // ── Product ──
  let product = await db.product.findFirst({ where: { importKey: row.productKey, deletedAt: null } })
    ?? (await db.product.findFirst({ where: { name: p.name, importKey: null, deletedAt: null } }));
  let created = false;
  const type = await typeId(db, row.typeName, plan.createMissing, messages);
  const category = await categoryId(db, type, row.categoryName, plan.createMissing, messages);
  const productData = {
    name: p.name, description: p.description, productDetails: p.details, specificationsCare: p.care, howToUse: p.howToUse,
    metaTitle: p.metaTitle, metaDescription: p.metaDescription, dataFlags: p.flags, typeId: type, categoryId: category,
    ...(p.isTrending !== null ? { isTrending: p.isTrending } : {}), ...(p.isNewArrival !== null ? { isNewArrival: p.isNewArrival } : {}),
  };
  if (!product) {
    const taken = new Set((await db.product.findMany({ where: { slug: { startsWith: p.slug } }, select: { slug: true } })).map((x) => x.slug));
    product = await db.product.create({ data: { ...productData, importKey: row.productKey, slug: uniqueSlug(p.slug, (s) => taken.has(s), 220), status: 'DRAFT', createdBy: ctx.actorId, updatedBy: ctx.actorId } });
    created = true;
    const techs = await techniqueIds(db, p.techniques);
    if (techs.length) await db.productTechnique.createMany({ data: techs.map((t) => ({ productId: product!.id, techniqueId: t })), skipDuplicates: true });
  } else if (row.lead) {
    if (!ctx.force && plan.productId === product.id && plan.productVersion !== product.version) return review('The product was changed in the admin after this file was checked', messages);
    const current = { name: product.name, description: product.description, productDetails: product.productDetails, specificationsCare: product.specificationsCare, howToUse: product.howToUse, metaTitle: product.metaTitle, metaDescription: product.metaDescription, dataFlags: product.dataFlags, typeId: product.typeId, categoryId: product.categoryId };
    const changed = Object.entries(productData).some(([k, val]) => JSON.stringify(val) !== JSON.stringify((current as Record<string, unknown>)[k] ?? (product as unknown as Record<string, unknown>)[k]));
    if (changed) {
      product = await db.product.update({ where: { id: product.id }, data: { ...productData, importKey: row.productKey, updatedBy: ctx.actorId, version: { increment: 1 } } });
      const techs = await techniqueIds(db, p.techniques);
      await db.productTechnique.deleteMany({ where: { productId: product.id } });
      if (techs.length) await db.productTechnique.createMany({ data: techs.map((t) => ({ productId: product!.id, techniqueId: t })), skipDuplicates: true });
    }
  }
  ctx.touched.add(product.id);

  // Images from the file attach only to a product that has none yet (never replace what the admin chose).
  if (p.images.length && (await db.productImage.count({ where: { productId: product.id } })) === 0) {
    const media = p.images.map((u) => ctx.images.get(u)).filter((m): m is number => m !== undefined);
    if (media.length) await db.productImage.createMany({ data: media.map((mediaId, i) => ({ productId: product!.id, mediaId, isCover: i === 0, sortOrder: i })), skipDuplicates: true });
    for (const u of p.images) if (!ctx.images.has(u)) messages.push({ code: 'IMAGE_FETCH_FAILED', text: `Image ${u} could not be downloaded` });
  }

  // ── Variant ──
  const imageMediaId = v.imageUrl ? (ctx.images.get(v.imageUrl) ?? null) : null;
  // WEIGHT_ESTIMATED follows the weight actually stored (estimates are not written back to the result file).
  const flagsFor = (source: string | null) => [...v.flags.filter((f) => f !== 'WEIGHT_ESTIMATED'), ...(source === 'ESTIMATED' ? ['WEIGHT_ESTIMATED'] : [])];
  const variantData = {
    size: v.size, netQuantity: v.netQuantity, netUnit: v.netUnit, color: v.color, thickness: v.thickness, dataFlags: flagsFor(v.weightSource),
    price: v.price, mrp: v.price === null ? null : v.mrp, ...(imageMediaId ? { imageMediaId } : {}),
  };
  const existing = await db.productVariant.findFirst({ where: { sku: v.sku, deletedAt: null } });
  if (!existing) {
    const label = [v.size, v.color, v.thickness].filter(Boolean).join(' / ') || 'Default';
    const sortOrder = await db.productVariant.count({ where: { productId: product.id } });
    const nv = await db.productVariant.create({
      data: { ...variantData, productId: product.id, sku: v.sku, label, sortOrder, weightG: v.weightG, weightSource: v.weightSource, ...(v.price !== null ? { priceApprovedAt: new Date() } : {}) },
    });
    await fn.importInitialStock(db, { variantId: nv.id, quantity: v.stock, importId: ctx.importId, actorId: ctx.actorId });
    return { status: 'CREATED', productId: product.id, variantId: nv.id, messages };
  }
  if (existing.productId !== product.id) throw new AppError(422, 'SKU_OTHER_PRODUCT', `SKU ${v.sku} belongs to another product`);
  if (!ctx.force && plan.variantId === existing.id && plan.variantVersion !== existing.version) return review('The variant was changed in the admin after this file was checked', messages);
  const weight = v.weightSource === 'MEASURED' || existing.weightG === null ? { weightG: v.weightG, weightSource: v.weightSource } : {};
  const next = { ...variantData, ...weight, dataFlags: flagsFor('weightSource' in weight ? weight.weightSource : existing.weightSource) };
  const changed = Object.entries(next).some(([k, val]) => JSON.stringify(val) !== JSON.stringify(k === 'netQuantity' ? (existing.netQuantity === null ? null : Number(existing.netQuantity)) : (existing as unknown as Record<string, unknown>)[k]));
  if (changed) {
    const priceChanged = existing.price !== v.price || existing.mrp !== next.mrp;
    await db.productVariant.update({ where: { id: existing.id }, data: { ...next, ...(priceChanged && v.price !== null ? { priceApprovedAt: new Date() } : {}), version: { increment: 1 } } });
  }
  return { status: changed || created ? 'UPDATED' : 'UNCHANGED', productId: product.id, variantId: existing.id, messages };
}
