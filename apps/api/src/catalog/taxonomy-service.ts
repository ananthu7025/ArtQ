// Product types, categories and techniques (api.md §4.4, task 2.6). One implementation for the three, driven by KINDS.
// Slugs are derived from the name and keep 301s when changed (storefront /types/:slug, /categories/:slug,
// /techniques/:slug). Delete is refused while anything uses the record, with counts and what to do instead.
// These tables carry no version column: edits are last-write-wins, and every change is audited.
import { uniqueSlug } from '@artq/shared';
import type { Media, Prisma, PrismaClient } from '@prisma/client';
import type { AuditEntry } from '../admin/router.js';
import type { Db } from '../db/functions.js';
import { AppError } from '../lib/errors.js';
import { assertUsableImages } from './media-check.js';

export type TaxonomyKind = 'type' | 'category' | 'technique';
export type TaxonomyActor = { userId: number; audit: (db: Db, e: AuditEntry) => Promise<void> };
type Render = (m: Media) => { renditions?: Record<string, string> } & Record<string, unknown>;
type Row = Record<string, unknown> & { id: number; name: string; slug: string };

const KINDS = {
  type: { table: 'product_types', label: 'product type', entity: 'product_type', redirect: 'type', slugMax: 100, media: ['imageMediaId', 'bannerMediaId'] },
  category: { table: 'categories', label: 'category', entity: 'category', redirect: 'category', slugMax: 120, media: ['imageMediaId'] },
  technique: { table: 'techniques', label: 'technique', entity: 'technique', redirect: 'technique', slugMax: 120, media: ['imageMediaId', 'heroMediaId'] },
} as const;

type Delegate = {
  findUnique(a: { where: { id: number } }): Promise<Row | null>;
  findMany(a: object): Promise<Row[]>;
  create(a: { data: object }): Promise<Row>;
  update(a: { where: { id: number }; data: object }): Promise<Row>;
  delete(a: { where: { id: number } }): Promise<Row>;
};
const model = (db: Db, k: TaxonomyKind) => ({ type: db.productType, category: db.category, technique: db.technique }[k]) as unknown as Delegate;
const TX = { maxWait: 10_000, timeout: 20_000 } as const;

export class TaxonomyService {
  constructor(private readonly prisma: PrismaClient, private readonly renderMedia: Render = (m) => ({ id: m.id, status: m.status, renditions: {} })) {}

  /** What uses a record: deletion is refused while any of these is non-zero. */
  async usage(k: TaxonomyKind, id: number, db: Db = this.prisma): Promise<{ products: number; categories?: number }> {
    if (k === 'type') {
      const [products, categories] = await Promise.all([db.product.count({ where: { typeId: id } }), db.category.count({ where: { typeId: id } })]);
      return { products, categories };
    }
    if (k === 'category') return { products: await db.product.count({ where: { categoryId: id } }) };
    return { products: await db.productTechnique.count({ where: { techniqueId: id } }) };
  }

  async get(k: TaxonomyKind, id: number) {
    const row = await model(this.prisma, k).findUnique({ where: { id } });
    if (!row) throw this.notFound(k);
    return this.view(k, row, await this.usage(k, id));
  }

  async create(k: TaxonomyKind, body: Record<string, unknown> & { name: string; slug?: string | undefined }, actor: TaxonomyActor) {
    const cfg = KINDS[k];
    const row = await this.prisma.$transaction(async (tx) => {
      await assertUsableImages(tx, cfg.media.map((f) => body[f]).filter((v): v is number => typeof v === 'number'));
      const slug = body.slug ?? (await this.freeSlug(tx, k, body.name));
      await tx.slugRedirect.deleteMany({ where: { entity: cfg.redirect, oldSlug: slug } });
      const created = await model(tx, k).create({ data: { ...body, slug } }).catch((e: unknown) => this.rethrow(k, e));
      await actor.audit(tx, { action: `${cfg.entity}.create`, entity: cfg.entity, entityId: created.id, after: { ...body, slug } });
      return created;
    }, TX);
    return this.get(k, row.id);
  }

  async update(k: TaxonomyKind, id: number, body: Record<string, unknown> & { slug?: string | undefined }, actor: TaxonomyActor) {
    const cfg = KINDS[k];
    await this.prisma.$transaction(async (tx) => {
      const current = await this.lock(tx, k, id);
      await assertUsableImages(tx, cfg.media.map((f) => body[f]).filter((v): v is number => typeof v === 'number'));
      if (body.slug !== undefined && body.slug !== current.slug) {
        // Re-point older redirects at the new slug (no chains), record old → new, and free the new slug.
        await tx.slugRedirect.deleteMany({ where: { entity: cfg.redirect, oldSlug: body.slug } });
        await tx.slugRedirect.updateMany({ where: { entity: cfg.redirect, newSlug: current.slug }, data: { newSlug: body.slug } });
        await tx.slugRedirect.upsert({
          where: { entity_oldSlug: { entity: cfg.redirect, oldSlug: current.slug } },
          create: { entity: cfg.redirect, oldSlug: current.slug, newSlug: body.slug }, update: { newSlug: body.slug },
        });
      }
      await model(tx, k).update({ where: { id }, data: body }).catch((e: unknown) => this.rethrow(k, e));
      const before = Object.fromEntries(Object.keys(body).map((f) => [f, current[f] instanceof Object && 'toNumber' in (current[f] as object) ? Number(current[f]) : current[f]]));
      await actor.audit(tx, { action: `${cfg.entity}.update`, entity: cfg.entity, entityId: id, before, after: body });
    }, TX);
    return this.get(k, id);
  }

  async remove(k: TaxonomyKind, id: number, actor: TaxonomyActor): Promise<void> {
    const cfg = KINDS[k];
    await this.prisma.$transaction(async (tx) => {
      const current = await this.lock(tx, k, id);
      const used = await this.usage(k, id, tx);
      if (used.products > 0 || (used.categories ?? 0) > 0) throw this.inUse(k, current.name, used);
      await model(tx, k).delete({ where: { id } }).catch((e: unknown) => this.rethrow(k, e));
      await tx.slugRedirect.deleteMany({ where: { entity: cfg.redirect, newSlug: current.slug } });
      await actor.audit(tx, { action: `${cfg.entity}.delete`, entity: cfg.entity, entityId: id, before: { name: current.name, slug: current.slug } });
    }, TX);
  }

  /** New display order: the listed ids get sort order 0, 1, 2… (all must exist). */
  async reorder(k: TaxonomyKind, ids: number[], actor: TaxonomyActor): Promise<void> {
    const cfg = KINDS[k];
    await this.prisma.$transaction(async (tx) => {
      const found = await model(tx, k).findMany({ where: { id: { in: ids } }, select: { id: true } });
      const missing = ids.filter((id) => !found.some((f) => f.id === id));
      if (missing.length) throw new AppError(422, 'NOT_FOUND', `Some ${cfg.label}s do not exist`, { ids: missing });
      for (const [i, id] of ids.entries()) await model(tx, k).update({ where: { id }, data: { sortOrder: i } });
      await actor.audit(tx, { action: `${cfg.entity}.reorder`, entity: cfg.entity, after: { ids } });
    }, TX);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async lock(tx: Db, k: TaxonomyKind, id: number): Promise<Row> {
    const [locked] = await tx.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM ${KINDS[k].table} WHERE id = $1 FOR UPDATE`, id);
    if (!locked) throw this.notFound(k);
    return (await model(tx, k).findUnique({ where: { id } }))!;
  }

  private async freeSlug(tx: Db, k: TaxonomyKind, name: string): Promise<string> {
    const max = KINDS[k].slugMax;
    const root = uniqueSlug(name, () => false, max);
    const taken = new Set((await model(tx, k).findMany({ where: { slug: { startsWith: root } }, select: { slug: true } })).map((r) => r.slug));
    return uniqueSlug(name, (s) => taken.has(s), max);
  }

  private notFound(k: TaxonomyKind) {
    const l = KINDS[k].label;
    return new AppError(404, 'NOT_FOUND', `${l[0]!.toUpperCase()}${l.slice(1)} not found`);
  }

  private inUse(k: TaxonomyKind, name: string, used: { products: number; categories?: number }) {
    const parts = [used.products ? `${used.products} product${used.products > 1 ? 's' : ''}` : null, used.categories ? `${used.categories} categor${used.categories > 1 ? 'ies' : 'y'}` : null].filter(Boolean).join(' and ');
    const fix = k === 'type' ? 'Move them to another type (or archive the products) first, or turn the type off to hide it.'
      : k === 'category' ? 'Move its products to another category (or archive them) first, or turn the category off to hide it.'
        : 'Remove the technique from those products first, or turn it off to hide it.';
    return new AppError(409, 'TAXONOMY_IN_USE', `“${name}” is used by ${parts}. ${fix}`, used);
  }

  /** Prisma constraint errors → clear API errors. */
  private rethrow(k: TaxonomyKind, e: unknown): never {
    const p = e as { code?: string; meta?: { target?: unknown; constraint?: unknown } };
    const target = JSON.stringify(p.meta?.target ?? '');
    if (p.code === 'P2002' && target.includes('slug')) throw new AppError(409, 'SLUG_TAKEN', `Another ${KINDS[k].label} already uses this URL slug`);
    if (p.code === 'P2002' && target.includes('name')) throw new AppError(409, 'NAME_TAKEN', 'This product type already has a category with this name');
    if (p.code === 'P2003' && String(p.meta?.constraint ?? '').includes('products_category_matches_type_fk')) {
      throw new AppError(409, 'TAXONOMY_IN_USE', 'Products use this category with its current type. Move them to another category first.');
    }
    if (p.code === 'P2003' && String(p.meta?.constraint ?? '').includes('type_id')) throw new AppError(422, 'TAXONOMY_NOT_FOUND', 'The product type does not exist');
    throw e;
  }

  private async view(k: TaxonomyKind, row: Row, used: { products: number; categories?: number }) {
    const ids = KINDS[k].media.map((f) => row[f]).filter((v): v is number => typeof v === 'number');
    const media = new Map((await this.prisma.media.findMany({ where: { id: { in: ids } } })).map((m) => [m.id, this.renderMedia(m)]));
    const decimals = Object.fromEntries(Object.entries(row).map(([f, v]) => [f, v !== null && typeof v === 'object' && 'toNumber' in v ? Number(v) : v]));
    return { ...decimals, media: Object.fromEntries(ids.map((m) => [m, media.get(m) ?? null])), usage: used } as Prisma.JsonObject;
  }
}
