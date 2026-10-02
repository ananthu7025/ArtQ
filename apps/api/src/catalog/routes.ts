// /v1/admin catalogue routes (api.md §4.3). Each endpoint accepts only the fields its permission covers (AT-10):
// content endpoints are catalog:write with no commercial fields; pricing is pricing:write; bulk content is catalog:write.
import { bulkBody, can, createProductBody, createVariantBody, idParam, pricingBody, updateProductBody, updateVariantBody, type Permission } from '@artq/shared';
import type { Request, RequestHandler, Response, Router } from 'express';
import { recordAudit } from '../admin/router.js';
import { AppError } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import type { CatalogActor, CatalogService } from './service.js';

type AdminRoutes = { routes: Router; can: (p: Permission) => RequestHandler };

const actor = (req: Request, res: Response): CatalogActor => ({
  userId: req.auth!.userId,
  seeCost: can(req.auth!.role, 'pricing:write'),
  audit: (db, e) => recordAudit(db, req, res, e),
});
const id = (req: Request) => (req.params as unknown as { id: number }).id;

export function registerCatalogRoutes(admin: AdminRoutes, catalog: CatalogService): void {
  const r = admin.routes;
  const noStore = (res: Response) => res.set('Cache-Control', 'private, no-store');

  r.post('/products', admin.can('catalog:write'), validate({ body: createProductBody }), async (req, res) => {
    noStore(res).status(201).json(await catalog.createProduct(req.body, actor(req, res)));
  });
  r.post('/products/bulk', admin.can('catalog:write'), validate({ body: bulkBody }), async (req, res) => {
    noStore(res).json(await catalog.bulk(req.body, actor(req, res)));
  });
  r.get('/products/:id', admin.can('catalog:read'), validate({ params: idParam }), async (req, res) => {
    const p = await catalog.getProduct(id(req), can(req.auth!.role, 'pricing:write'));
    if (!p) throw new AppError(404, 'NOT_FOUND', 'Product not found');
    noStore(res).json(p);
  });
  r.patch('/products/:id', admin.can('catalog:write'), validate({ params: idParam, body: updateProductBody }), async (req, res) => {
    noStore(res).json(await catalog.updateProduct(id(req), req.body, actor(req, res)));
  });
  r.delete('/products/:id', admin.can('catalog:write'), validate({ params: idParam }), async (req, res) => {
    await catalog.deleteProduct(id(req), actor(req, res));
    res.status(204).end();
  });
  r.post('/products/:id/variants', admin.can('catalog:write'), validate({ params: idParam, body: createVariantBody }), async (req, res) => {
    noStore(res).status(201).json(await catalog.addVariant(id(req), req.body, actor(req, res)));
  });
  r.patch('/variants/:id', admin.can('catalog:write'), validate({ params: idParam, body: updateVariantBody }), async (req, res) => {
    noStore(res).json(await catalog.updateVariant(id(req), req.body, actor(req, res)));
  });
  r.patch('/variants/:id/pricing', admin.can('pricing:write'), validate({ params: idParam, body: pricingBody }), async (req, res) => {
    noStore(res).json(await catalog.updatePricing(id(req), req.body, actor(req, res)));
  });
}
