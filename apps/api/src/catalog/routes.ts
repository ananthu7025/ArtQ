// /v1/admin catalogue routes (api.md §4.3). Each endpoint accepts only the fields its permission covers (AT-10):
// content endpoints are catalog:write with no commercial fields; pricing is pricing:write; bulk content is catalog:write.
import { BULK_PUBLISH_ACTIONS, bulkBody, can, createProductBody, createVariantBody, emptyBody, idParam, pricingBody, productListQuery, taxApprovalBody, updateProductBody, updateVariantBody, type Bulk, type Permission, type ProductListQuery } from '@artq/shared';
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
  // Content actions need catalog:write, publication actions catalog:publish. A caller with neither is refused before the
  // body is read (403, as in AT-10); otherwise the action decides.
  const eitherBulkPermission: RequestHandler = (req, _res, next) =>
    next(req.auth && (can(req.auth.role, 'catalog:write') || can(req.auth.role, 'catalog:publish')) ? undefined
      : new AppError(403, 'FORBIDDEN', 'You do not have permission to do this', { permission: 'catalog:write' }));
  const bulkPermission: RequestHandler = (req, res, next) =>
    admin.can((BULK_PUBLISH_ACTIONS as readonly string[]).includes((req.body as Bulk).action) ? 'catalog:publish' : 'catalog:write')(req, res, next);
  r.post('/products/bulk', eitherBulkPermission, validate({ body: bulkBody }), bulkPermission, async (req, res) => {
    noStore(res).json(await catalog.bulk(req.body, actor(req, res)));
  });
  r.get('/products/:id/readiness', admin.can('catalog:read'), validate({ params: idParam }), async (req, res) => {
    noStore(res).json(await catalog.getReadiness(id(req)));
  });
  for (const action of BULK_PUBLISH_ACTIONS) {
    r.post(`/products/:id/${action}`, admin.can('catalog:publish'), validate({ params: idParam, body: emptyBody }), async (req, res) => {
      const a = actor(req, res);
      await catalog.setStatus(id(req), action, a);
      noStore(res).json(await catalog.getProduct(id(req), a.seeCost));
    });
  }
  r.post('/products/:id/tax-approval', admin.can('catalog:publish'), validate({ params: idParam, body: taxApprovalBody }), async (req, res) => {
    noStore(res).json(await catalog.approveTax(id(req), req.body, actor(req, res)));
  });
  r.get('/products', admin.can('catalog:read'), validate({ query: productListQuery }), async (req, res) => {
    noStore(res).json(await catalog.listProducts(req.query as unknown as ProductListQuery));
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
