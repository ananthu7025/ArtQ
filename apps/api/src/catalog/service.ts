// Catalogue services (task 2.2, api.md §4.3). Content and pricing are separate paths (architecture.md §5.9): the content
// methods never touch price/mrp/cost/stock, and updatePricing is the only writer of commercial fields.
//
// Locking (database.md §4.1): a variant change locks ALL the product's variants in ascending id order (FOR NO KEY UPDATE),
// writes, then aq_refresh_products locks the product and recomputes the aggregates in the same transaction.
// Optimistic concurrency: every update carries `version`; a mismatch is 409 VERSION_CONFLICT with the current data.
import { normaliseSize, uniqueSlug } from '@artq/shared';
import type { Media, Prisma, PrismaClient, Product, ProductVariant } from '@prisma/client';
import type { AuditEntry } from '../admin/router.js';
import * as fn from '../db/functions.js';
import type { Db } from '../db/functions.js';
import { AppError } from '../lib/errors.js';
import { rethrowCatalog } from './errors.js';
import type { Bulk, CreateProduct, CreateVariant, Pricing, UpdateProduct, UpdateVariant } from './schemas.js';

export type CatalogActor = {
  userId: number;
  /** pricing:write holders see cost price in payloads. */
  seeCost: boolean;
  /** Records an audit row in the given transaction (recordAudit bound to the request). */
  audit: (db: Db, e: AuditEntry) => Promise<void>;
};

export type MediaRender = (m: Media) => unknown;

const TX = { maxWait: 10_000, timeout: 20_000 } as const;
const SLUG_MAX = 220;
const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`);

const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));

type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };
/** Drops keys whose value is undefined (zod's optional output vs Prisma under exactOptionalPropertyTypes). */
function defined<T extends object>(o: T): Defined<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Defined<T>;
}

export function variantView(v: ProductVariant, seeCost: boolean) {
  return {
    id: v.id, productId: v.productId, sku: v.sku, label: v.label, size: v.size, netQuantity: num(v.netQuantity), netUnit: v.netUnit,
    color: v.color, colorHex: v.colorHex, thickness: v.thickness, price: v.price, mrp: v.mrp, priceApprovedAt: v.priceApprovedAt,
    ...(seeCost ? { costPrice: v.costPrice } : {}),
    onHand: v.onHand, reserved: v.reserved, available: Math.max(v.onHand - v.reserved, 0), inventoryCountedAt: v.inventoryCountedAt,
    lowStockThreshold: v.lowStockThreshold, weightG: v.weightG, weightSource: v.weightSource,
    lengthCm: num(v.lengthCm), widthCm: num(v.widthCm), heightCm: num(v.heightCm), shippingClass: v.shippingClass,
    imageMediaId: v.imageMediaId, barcode: v.barcode, sortOrder: v.sortOrder, isActive: v.isActive, dataFlags: v.dataFlags, version: v.version,
  };
}

/** Size text without an explicit net quantity/unit is normalised (catalog.md "Size normalisation"); the pair must be complete. */
function applySize(data: CreateVariant | UpdateVariant, current?: ProductVariant): void {
  if (typeof data.size === 'string' && data.size !== '' && data.netQuantity === undefined && data.netUnit === undefined) {
    const n = normaliseSize(data.size);
    if (!n.ok) throw new AppError(422, 'SIZE_INVALID', `Size "${data.size}" needs a unit, e.g. 500 gm, 1 kg, 8 in or 4×6 in`, { reason: n.reason });
    Object.assign(data, { size: n.label, netQuantity: n.netQuantity, netUnit: n.netUnit });
  }
  const qty = data.netQuantity !== undefined ? data.netQuantity : num(current?.netQuantity ?? null);
  const unit = data.netUnit !== undefined ? data.netUnit : (current?.netUnit ?? null);
  if ((qty === null) !== (unit === null)) throw new AppError(422, 'SIZE_INVALID', 'Give the net quantity and its unit together');
}

/** Flags can only be resolved (removed) by an admin; new flags come from imports. */
function assertFlagsResolvedOnly(next: string[] | undefined, current: string[]): void {
  const added = next?.filter((f) => !current.includes(f)) ?? [];
  if (added.length) throw new AppError(422, 'FLAGS_ADD_FORBIDDEN', 'Data flags can be resolved here, not added', { flags: added });
}

export class CatalogService {
  constructor(private readonly prisma: PrismaClient, private readonly renderMedia: MediaRender = (m) => ({ id: m.id, status: m.status })) {}

  // ── Reads ────────────────────────────────────────────────────────────────

  /** Editor payload (api.md §4.3 GET /admin/products/:id). */
  async getProduct(id: number, seeCost: boolean, db: Db = this.prisma) {
    const p = await db.product.findUnique({
      where: { id },
      include: {
        type: { select: { id: true, name: true, slug: true } },
        category: { select: { id: true, name: true, slug: true, typeId: true } },
        techniques: { select: { techniqueId: true }, orderBy: { techniqueId: 'asc' } },
        variants: { where: { deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
        images: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], include: { media: true } },
      },
    });
    if (!p || p.deletedAt) return null;
    const [r] = await db.$queryRaw<{ f: string[] }[]>`SELECT product_readiness_failures(p) AS f FROM products p WHERE p.id = ${id}`;
    return {
      id: p.id, status: p.status, publishedAt: p.publishedAt, name: p.name, slug: p.slug, shortDescription: p.shortDescription,
      description: p.description, productDetails: p.productDetails, specificationsCare: p.specificationsCare, howToUse: p.howToUse,
      specifications: p.specifications, tags: p.tags, type: p.type, category: p.category && { id: p.category.id, name: p.category.name, slug: p.category.slug },
      techniqueIds: p.techniques.map((t) => t.techniqueId), hsnCode: p.hsnCode, gstRate: p.gstRate === null ? null : Number(p.gstRate),
      taxApprovedAt: p.taxApprovedAt, isNewArrival: p.isNewArrival, newArrivalRank: p.newArrivalRank, isTrending: p.isTrending,
      trendingRank: p.trendingRank, isFeatured: p.isFeatured, sortOrder: p.sortOrder, metaTitle: p.metaTitle, metaDescription: p.metaDescription,
      dataFlags: p.dataFlags, importKey: p.importKey,
      aggregates: { minPrice: p.minPrice, maxPrice: p.maxPrice, maxMrp: p.maxMrp, available: p.availableQty, activeVariants: p.activeVariantCount },
      variants: p.variants.map((v) => variantView(v, seeCost)),
      images: p.images.map((i) => ({ id: i.id, mediaId: i.mediaId, alt: i.alt, sortOrder: i.sortOrder, isCover: i.isCover, media: this.renderMedia(i.media) })),
      readiness: { ready: (r?.f ?? []).length === 0, failures: r?.f ?? [] },
      version: p.version, createdAt: p.createdAt, updatedAt: p.updatedAt,
    };
  }

  /** Storefront resolution: live slug, else a 301 target from slug_redirects, else null. */
  async resolveProductSlug(slug: string): Promise<{ productId: number } | { redirectTo: string } | null> {
    const p = await this.prisma.product.findUnique({ where: { slug }, select: { id: true } });
    if (p) return { productId: p.id };
    const r = await this.prisma.slugRedirect.findUnique({ where: { entity_oldSlug: { entity: 'product', oldSlug: slug } } });
    return r ? { redirectTo: r.newSlug } : null;
  }

  // ── Products ─────────────────────────────────────────────────────────────

  async createProduct(body: CreateProduct, actor: CatalogActor) {
    const { variants = [], techniqueIds, ...content } = body;
    const id = await this.prisma.$transaction(async (tx) => {
      const taxonomy = await this.resolveTaxonomy(tx, body.typeId, body.categoryId, null);
      const slug = content.slug ?? (await this.freeSlug(tx, content.name));
      await this.claimSlug(tx, slug);
      const p = await tx.product.create({
        data: { ...defined(content), name: content.name, ...taxonomy, slug, specifications: content.specifications ?? {}, status: 'DRAFT', createdBy: actor.userId, updatedBy: actor.userId },
      }).catch(rethrowCatalog);
      if (techniqueIds?.length) await tx.productTechnique.createMany({ data: [...new Set(techniqueIds)].map((t) => ({ productId: p.id, techniqueId: t })) }).catch(rethrowCatalog);
      for (const [i, v] of variants.entries()) await this.insertVariant(tx, p.id, v, i + 1);
      if (variants.length) await fn.refreshProducts(tx, [p.id]);
      await actor.audit(tx, { action: 'product.create', entity: 'product', entityId: p.id, after: { ...content, slug, techniqueIds, variants: variants.length } });
      return p.id;
    }, TX);
    return (await this.getProduct(id, actor.seeCost))!;
  }

  async updateProduct(id: number, body: UpdateProduct, actor: CatalogActor) {
    const { version, techniqueIds, ...content } = body;
    await this.prisma.$transaction(async (tx) => {
      const current = await this.lockProductVersion(tx, id, version, actor.seeCost);
      assertFlagsResolvedOnly(content.dataFlags, current.dataFlags);
      const taxonomy = (content.typeId !== undefined || content.categoryId !== undefined)
        ? await this.resolveTaxonomy(tx, content.typeId, content.categoryId, current) : {};
      if (content.slug !== undefined && content.slug !== current.slug) {
        await this.claimSlug(tx, content.slug);
        await this.redirectSlug(tx, current.slug, content.slug);
      }
      const data = { ...defined(content), ...taxonomy };
      await tx.product.update({ where: { id }, data: { ...data, updatedBy: actor.userId, version: { increment: 1 } } }).catch(rethrowCatalog);
      if (techniqueIds !== undefined) {
        await tx.productTechnique.deleteMany({ where: { productId: id } });
        if (techniqueIds.length) await tx.productTechnique.createMany({ data: [...new Set(techniqueIds)].map((t) => ({ productId: id, techniqueId: t })) }).catch(rethrowCatalog);
      }
      const before = Object.fromEntries(Object.keys(data).map((k) => [k, current[k as keyof Product]]));
      await actor.audit(tx, { action: 'product.update', entity: 'product', entityId: id, before, after: { ...data, ...(techniqueIds ? { techniqueIds } : {}) } });
    }, TX);
    return (await this.getProduct(id, actor.seeCost))!;
  }

  /** Hard delete only for drafts never referenced by orders, carts or imports (api.md §4.3); otherwise "Archive instead". */
  async deleteProduct(id: number, actor: CatalogActor): Promise<void> {
    const archive = (why: string) => new AppError(409, 'ARCHIVE_INSTEAD', `This product cannot be deleted (${why}); archive it instead`, { reason: why });
    await this.prisma.$transaction(async (tx) => {
      await this.lockVariants(tx, id);
      const [p] = await tx.$queryRaw<Pick<Product, 'id' | 'status' | 'slug' | 'importKey'>[]>`SELECT id, status, slug, import_key AS "importKey" FROM products WHERE id = ${id} AND deleted_at IS NULL FOR NO KEY UPDATE`;
      if (!p) throw notFound('Product');
      if (p.status !== 'DRAFT') throw archive('it has been published');
      if (p.importKey) throw archive('it came from an import');
      const [orders, carts, imports] = await Promise.all([
        tx.orderItem.count({ where: { productId: id } }),
        tx.cartItem.count({ where: { variant: { productId: id } } }),
        tx.productImportRow.count({ where: { productId: id } }),
      ]);
      if (orders) throw archive('it is in orders');
      if (carts) throw archive('it is in shopping carts');
      if (imports) throw archive('it came from an import');
      try {
        await tx.productVariant.deleteMany({ where: { productId: id } });
        await tx.product.delete({ where: { id } });
      } catch (e) {
        // Stock history (movements, reservations) is kept forever: its RESTRICT foreign keys refuse the delete.
        if ((e as { code?: string }).code === 'P2003') throw archive('it has stock history');
        throw e;
      }
      await tx.slugRedirect.deleteMany({ where: { entity: 'product', newSlug: p.slug } });
      await tx.searchReindexQueue.deleteMany({ where: { productId: id } });
      await actor.audit(tx, { action: 'product.delete', entity: 'product', entityId: id, before: { slug: p.slug } });
    }, TX);
  }

  /** Content bulk actions (catalog:write) with a per-item result (api.md §4.3). */
  async bulk(body: Bulk, actor: CatalogActor) {
    const results: { id: number; ok: boolean; error?: { code: string; message: string } }[] = [];
    let target: { typeId: number; categoryId?: number } | undefined;
    if (body.action === 'setCategory') {
      const c = await this.prisma.category.findUnique({ where: { id: body.categoryId } });
      if (!c) throw new AppError(422, 'TAXONOMY_NOT_FOUND', 'The category does not exist');
      target = { typeId: c.typeId, categoryId: c.id };
    } else if (body.action === 'setType') {
      if (!(await this.prisma.productType.findUnique({ where: { id: body.typeId } }))) throw new AppError(422, 'TAXONOMY_NOT_FOUND', 'The product type does not exist');
      target = { typeId: body.typeId };
    }
    for (const id of [...new Set(body.ids)].sort((a, b) => a - b)) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const [p] = await tx.$queryRaw<{ status: string; categoryId: number | null; categoryTypeId: number | null }[]>`
            SELECT p.status, p.category_id AS "categoryId", c.type_id AS "categoryTypeId"
              FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ${id} AND p.deleted_at IS NULL FOR NO KEY UPDATE OF p`;
          if (!p) throw notFound('Product');
          let data: Prisma.ProductUncheckedUpdateInput;
          switch (body.action) {
            case 'markNew': data = { isNewArrival: true }; break;
            case 'unmarkNew': data = { isNewArrival: false, newArrivalRank: null }; break;
            case 'markTrending': data = { isTrending: true }; break;
            case 'unmarkTrending': data = { isTrending: false, trendingRank: null }; break;
            case 'setCategory': data = { typeId: target!.typeId, categoryId: target!.categoryId! }; break;
            case 'setType': {
              // The category must belong to the type: a draft's mismatched category is cleared; a live product keeps it and fails.
              const keep = p.categoryTypeId === target!.typeId;
              if (!keep && p.status === 'ACTIVE') throw new AppError(422, 'CATEGORY_TYPE_MISMATCH', 'Choose a category of the new type first (the product is live)');
              data = { typeId: target!.typeId, ...(keep ? {} : { categoryId: null }) };
              break;
            }
          }
          await tx.product.update({ where: { id }, data: { ...data, updatedBy: actor.userId, version: { increment: 1 } } }).catch(rethrowCatalog);
        }, TX);
        results.push({ id, ok: true });
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        results.push({ id, ok: false, error: { code: e.code, message: e.message } });
      }
    }
    await actor.audit(this.prisma, { action: `product.bulk_${body.action}`, entity: 'product', after: { ...body, results: results.map((r) => ({ id: r.id, ok: r.ok })) } });
    return { results };
  }

  // ── Variants ─────────────────────────────────────────────────────────────

  async addVariant(productId: number, body: CreateVariant, actor: CatalogActor) {
    const id = await this.prisma.$transaction(async (tx) => {
      // Variants, then the product row (the global order). The product lock also serialises adds to a product that has no
      // variants yet; the SKU sequence is read in a later statement so it sees every add committed before the lock.
      await this.lockVariants(tx, productId);
      const [p] = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM products WHERE id = ${productId} AND deleted_at IS NULL FOR NO KEY UPDATE`;
      if (!p) throw notFound('Product');
      const v = await this.insertVariant(tx, productId, body, await this.nextSkuNumber(tx, productId));
      await fn.refreshProducts(tx, [productId]);
      await actor.audit(tx, { action: 'variant.create', entity: 'variant', entityId: v.id, after: { productId, ...body, sku: v.sku } });
      return v.id;
    }, TX);
    return variantView(await this.prisma.productVariant.findUniqueOrThrow({ where: { id } }), actor.seeCost);
  }

  async updateVariant(id: number, body: UpdateVariant, actor: CatalogActor) {
    const { version, ...content } = body;
    const v = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockVariantVersion(tx, id, version, actor.seeCost);
      assertFlagsResolvedOnly(content.dataFlags, current.dataFlags);
      applySize(content, current);
      const updated = await tx.productVariant.update({ where: { id }, data: { ...defined(content), version: { increment: 1 } } }).catch(rethrowCatalog);
      await fn.refreshProducts(tx, [current.productId]);
      const before = Object.fromEntries(Object.keys(content).map((k) => [k, current[k as keyof ProductVariant]]));
      await actor.audit(tx, { action: 'variant.update', entity: 'variant', entityId: id, before, after: content });
      return updated;
    }, TX);
    return variantView(v, actor.seeCost);
  }

  /** pricing:write: the only path that changes price, MRP or cost. Audited with before/after. */
  async updatePricing(id: number, body: Pricing, actor: CatalogActor) {
    const { version, ...pricing } = body;
    const v = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockVariantVersion(tx, id, version, true);
      const updated = await tx.productVariant.update({
        where: { id },
        data: { price: pricing.price, mrp: pricing.mrp, ...(pricing.costPrice !== undefined ? { costPrice: pricing.costPrice } : {}), priceApprovedAt: new Date(), version: { increment: 1 } },
      }).catch(rethrowCatalog);
      await fn.refreshProducts(tx, [current.productId]);
      await actor.audit(tx, {
        action: 'variant.price_update', entity: 'variant', entityId: id,
        before: { price: current.price, mrp: current.mrp, costPrice: current.costPrice }, after: { costPrice: current.costPrice, ...pricing },
      });
      return updated;
    }, TX);
    return variantView(v, true);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Locks every variant of the product in ascending id order (the global lock order: variants before products). */
  private lockVariants(tx: Db, productId: number) {
    return tx.$queryRaw<{ id: number }[]>`SELECT id FROM product_variants WHERE product_id = ${productId} ORDER BY id FOR NO KEY UPDATE`;
  }

  private async lockVariantVersion(tx: Db, id: number, version: number, seeCost: boolean): Promise<ProductVariant> {
    const head = await tx.productVariant.findFirst({ where: { id, deletedAt: null }, select: { productId: true } });
    if (!head) throw notFound('Variant');
    await this.lockVariants(tx, head.productId);
    const current = await tx.productVariant.findUniqueOrThrow({ where: { id } });
    if (current.deletedAt) throw notFound('Variant');
    if (current.version !== version) {
      throw new AppError(409, 'VERSION_CONFLICT', 'Someone else changed this variant; review the latest values and try again', { current: variantView(current, seeCost) });
    }
    return current;
  }

  private async lockProductVersion(tx: Db, id: number, version: number, seeCost: boolean): Promise<Product> {
    const [locked] = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM products WHERE id = ${id} AND deleted_at IS NULL FOR NO KEY UPDATE`;
    if (!locked) throw notFound('Product');
    const current = await tx.product.findUniqueOrThrow({ where: { id } });
    if (current.version !== version) {
      throw new AppError(409, 'VERSION_CONFLICT', 'Someone else changed this product; review the latest values and try again', { current: await this.getProduct(id, seeCost, tx) });
    }
    return current;
  }

  /** n for a generated SKU `P<product>-V<n>`: one past the variant count, skipping numbers already used by live SKUs. */
  private async nextSkuNumber(tx: Db, productId: number): Promise<number> {
    const rows = await tx.productVariant.findMany({ where: { productId }, select: { sku: true, deletedAt: true } });
    const live = new Set(rows.filter((r) => !r.deletedAt).map((r) => r.sku));
    let n = rows.length + 1;
    while (live.has(`P${productId}-V${n}`)) n++;
    return n;
  }

  private async insertVariant(tx: Db, productId: number, body: CreateVariant, n: number) {
    const data = { ...body };
    applySize(data);
    const label = data.label ?? ([data.size, data.color, data.thickness].filter(Boolean).join(' / ') || 'Default');
    const sku = data.sku ?? `P${productId}-V${n}`;
    return tx.productVariant.create({ data: { ...defined(data), label, sku, productId } }).catch(rethrowCatalog);
  }

  /**
   * Type and category must agree (products_category_matches_type_fk). A category alone implies its type; changing only
   * the type keeps the current category when it belongs to the new type and refuses otherwise.
   */
  private async resolveTaxonomy(tx: Db, typeId: number | null | undefined, categoryId: number | null | undefined, current: Product | null) {
    const nextCategory = categoryId !== undefined ? categoryId : (current?.categoryId ?? null);
    let nextType = typeId !== undefined ? typeId : (current?.typeId ?? null);
    if (nextCategory !== null) {
      const c = await tx.category.findUnique({ where: { id: nextCategory }, select: { typeId: true } });
      if (!c) throw new AppError(422, 'TAXONOMY_NOT_FOUND', 'The category does not exist');
      if (typeId === undefined) nextType = c.typeId;
      if (nextType !== c.typeId) throw new AppError(422, 'CATEGORY_TYPE_MISMATCH', 'The category does not belong to the chosen product type');
    }
    if (nextType !== null && !(await tx.productType.findUnique({ where: { id: nextType }, select: { id: true } }))) {
      throw new AppError(422, 'TAXONOMY_NOT_FOUND', 'The product type does not exist');
    }
    return { typeId: nextType, categoryId: nextCategory };
  }

  private async freeSlug(tx: Db, name: string): Promise<string> {
    const root = uniqueSlug(name, () => false, SLUG_MAX);
    const taken = new Set((await tx.product.findMany({ where: { slug: { startsWith: root } }, select: { slug: true } })).map((p) => p.slug));
    return uniqueSlug(name, (s) => taken.has(s), SLUG_MAX);
  }

  /** A slug that used to redirect elsewhere now belongs to a live product: drop the stale redirect. */
  private async claimSlug(tx: Db, slug: string): Promise<void> {
    await tx.slugRedirect.deleteMany({ where: { entity: 'product', oldSlug: slug } });
  }

  /** old → new 301; earlier redirects to `old` are re-pointed at `new` so there are never chains. */
  private async redirectSlug(tx: Db, oldSlug: string, newSlug: string): Promise<void> {
    await tx.slugRedirect.updateMany({ where: { entity: 'product', newSlug: oldSlug }, data: { newSlug } });
    await tx.slugRedirect.upsert({
      where: { entity_oldSlug: { entity: 'product', oldSlug } }, create: { entity: 'product', oldSlug, newSlug }, update: { newSlug },
    });
  }
}
