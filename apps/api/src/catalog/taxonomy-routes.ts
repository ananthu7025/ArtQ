// Product types, categories and techniques, read side (api.md §4.4) for the Products page tabs, filters and bulk "Set type/category".
// Create/update/delete arrive with task 2.6.
import { categoriesQuery, productTypesQuery, type Permission } from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import type { RequestHandler, Router } from 'express';
import type { z } from 'zod';
import { validate } from '../middleware/validate.js';

type AdminRoutes = { routes: Router; can: (p: Permission) => RequestHandler };

export function registerTaxonomyRoutes(admin: AdminRoutes, prisma: PrismaClient): void {
  const r = admin.routes;

  /** `?withCounts=1` adds live (non-deleted) product counts per type, plus Unassigned and All, for the type tabs. */
  r.get('/product-types', admin.can('catalog:read'), validate({ query: productTypesQuery }), async (req, res) => {
    const q = req.query as unknown as z.infer<typeof productTypesQuery>;
    const types = await prisma.productType.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true, slug: true, sortOrder: true, isActive: true } });
    res.set('Cache-Control', 'private, no-store');
    if (q.withCounts !== '1') { res.json({ data: types }); return; }
    const counts = await prisma.product.groupBy({ by: ['typeId'], where: { deletedAt: null }, _count: { _all: true } });
    const byType = new Map(counts.map((c) => [c.typeId, c._count._all]));
    res.json({
      data: types.map((t) => ({ ...t, productCount: byType.get(t.id) ?? 0 })),
      unassigned: byType.get(null) ?? 0,
      total: counts.reduce((n, c) => n + c._count._all, 0),
    });
  });

  r.get('/techniques', admin.can('catalog:read'), async (_req, res) => {
    const data = await prisma.technique.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true, slug: true, isActive: true } });
    res.set('Cache-Control', 'private, no-store').json({ data });
  });

  r.get('/categories', admin.can('catalog:read'), validate({ query: categoriesQuery }), async (req, res) => {
    const q = req.query as unknown as z.infer<typeof categoriesQuery>;
    const data = await prisma.category.findMany({
      where: q.typeId ? { typeId: q.typeId } : {}, orderBy: [{ typeId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, slug: true, typeId: true, isActive: true },
    });
    res.set('Cache-Control', 'private, no-store').json({ data });
  });
}
