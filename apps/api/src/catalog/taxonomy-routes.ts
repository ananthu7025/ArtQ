// Product types, categories and techniques (api.md §4.4). Reads: catalog:read (Products page tabs, filters, editor);
// changes: catalog:write (task 2.6). Lists with `?withCounts=1` add usage counts for the admin pages.
import {
  categoriesQuery, createCategoryBody, createProductTypeBody, createTechniqueBody, productTypesQuery, reorderBody, techniquesQuery,
  updateCategoryBody, updateProductTypeBody, updateTechniqueBody, type Permission,
} from '@artq/shared';
import type { Media, PrismaClient } from '@prisma/client';
import type { Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { recordAudit } from '../admin/router.js';
import { validate } from '../middleware/validate.js';
import { TaxonomyService, type TaxonomyActor, type TaxonomyKind } from './taxonomy-service.js';

type AdminRoutes = { routes: Router; can: (p: Permission) => RequestHandler };
type Render = (m: Media) => { renditions?: Record<string, string> } & Record<string, unknown>;
const idParam = z.strictObject({ id: z.coerce.number().int().positive() });

const ROUTES: { kind: TaxonomyKind; path: string; create: z.ZodType; update: z.ZodType }[] = [
  { kind: 'type', path: '/product-types', create: createProductTypeBody, update: updateProductTypeBody },
  { kind: 'category', path: '/categories', create: createCategoryBody, update: updateCategoryBody },
  { kind: 'technique', path: '/techniques', create: createTechniqueBody, update: updateTechniqueBody },
];

export function registerTaxonomyRoutes(admin: AdminRoutes, prisma: PrismaClient, renderMedia?: Render): void {
  const r = admin.routes;
  const service = new TaxonomyService(prisma, renderMedia);
  const thumb = async (ids: (number | null)[]) => {
    const list = ids.filter((v): v is number => v !== null);
    const media = await prisma.media.findMany({ where: { id: { in: list } } });
    return new Map(media.map((m) => {
      const rend = renderMedia ? (renderMedia(m).renditions ?? {}) : {};
      return [m.id, { status: m.status, url: rend['160'] ?? Object.values(rend)[0] ?? null }];
    }));
  };
  const noStore = (res: Response) => res.set('Cache-Control', 'private, no-store');
  const actor = (req: Request, res: Response): TaxonomyActor => ({ userId: req.auth!.userId, audit: (db, e) => recordAudit(db, req, res, e) });

  /** `?withCounts=1` adds product (and category) counts per type, plus Unassigned and All, for tabs and the admin page. */
  r.get('/product-types', admin.can('catalog:read'), validate({ query: productTypesQuery }), async (req, res) => {
    const q = req.query as unknown as z.infer<typeof productTypesQuery>;
    const types = await prisma.productType.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true, slug: true, sortOrder: true, isActive: true, showOnHome: true, showInMenu: true, imageMediaId: true } });
    const images = await thumb(types.map((t) => t.imageMediaId));
    const rows = types.map(({ imageMediaId, ...t }) => ({ ...t, image: imageMediaId === null ? null : (images.get(imageMediaId) ?? null) }));
    noStore(res);
    if (q.withCounts !== '1') { res.json({ data: rows }); return; }
    const [products, categories] = await Promise.all([
      prisma.product.groupBy({ by: ['typeId'], where: { deletedAt: null }, _count: { _all: true } }),
      prisma.category.groupBy({ by: ['typeId'], _count: { _all: true } }),
    ]);
    const byType = new Map(products.map((c) => [c.typeId, c._count._all]));
    const cats = new Map(categories.map((c) => [c.typeId, c._count._all]));
    res.json({
      data: rows.map((t) => ({ ...t, productCount: byType.get(t.id) ?? 0, categoryCount: cats.get(t.id) ?? 0 })),
      unassigned: byType.get(null) ?? 0,
      total: products.reduce((n, c) => n + c._count._all, 0),
    });
  });

  r.get('/categories', admin.can('catalog:read'), validate({ query: categoriesQuery }), async (req, res) => {
    const q = req.query as unknown as z.infer<typeof categoriesQuery>;
    const list = await prisma.category.findMany({
      where: q.typeId ? { typeId: q.typeId } : {}, orderBy: [{ typeId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, slug: true, typeId: true, isActive: true, sortOrder: true, imageMediaId: true },
    });
    const images = await thumb(list.map((c) => c.imageMediaId));
    const counts = q.withCounts === '1' ? new Map((await prisma.product.groupBy({ by: ['categoryId'], where: { deletedAt: null }, _count: { _all: true } })).map((c) => [c.categoryId, c._count._all])) : null;
    noStore(res).json({ data: list.map(({ imageMediaId, ...c }) => ({ ...c, image: imageMediaId === null ? null : (images.get(imageMediaId) ?? null), ...(counts ? { productCount: counts.get(c.id) ?? 0 } : {}) })) });
  });

  r.get('/techniques', admin.can('catalog:read'), validate({ query: techniquesQuery }), async (req, res) => {
    const q = req.query as unknown as z.infer<typeof techniquesQuery>;
    const list = await prisma.technique.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true, slug: true, isActive: true, sortOrder: true, imageMediaId: true } });
    const images = await thumb(list.map((t) => t.imageMediaId));
    const counts = q.withCounts === '1' ? new Map((await prisma.productTechnique.groupBy({ by: ['techniqueId'], _count: { _all: true } })).map((c) => [c.techniqueId, c._count._all])) : null;
    noStore(res).json({ data: list.map(({ imageMediaId, ...t }) => ({ ...t, image: imageMediaId === null ? null : (images.get(imageMediaId) ?? null), ...(counts ? { productCount: counts.get(t.id) ?? 0 } : {}) })) });
  });

  for (const { kind, path, create, update } of ROUTES) {
    // Before `/:id`, so "reorder" is never read as an id.
    r.patch(`${path}/reorder`, admin.can('catalog:write'), validate({ body: reorderBody }), async (req, res) => {
      await service.reorder(kind, (req.body as z.infer<typeof reorderBody>).ids, actor(req, res));
      noStore(res).json({ ok: true });
    });
    r.get(`${path}/:id`, admin.can('catalog:read'), validate({ params: idParam }), async (req, res) => {
      noStore(res).json(await service.get(kind, (req.params as unknown as { id: number }).id));
    });
    r.post(path, admin.can('catalog:write'), validate({ body: create }), async (req, res) => {
      noStore(res).status(201).json(await service.create(kind, req.body, actor(req, res)));
    });
    r.patch(`${path}/:id`, admin.can('catalog:write'), validate({ params: idParam, body: update }), async (req, res) => {
      noStore(res).json(await service.update(kind, (req.params as unknown as { id: number }).id, req.body, actor(req, res)));
    });
    r.delete(`${path}/:id`, admin.can('catalog:write'), validate({ params: idParam }), async (req, res) => {
      await service.remove(kind, (req.params as unknown as { id: number }).id, actor(req, res));
      res.status(204).end();
    });
  }
}
