// Admin Orders routes (task 5.1; api.md §4.3). orders:read for the list, detail and packing slip; orders:fulfil for
// confirm / pack / out for delivery / delivered, the address correction and staff note, and resending an email.
// Contact details are masked for staff without customers:write (architecture.md §5.9).
import {
  adminOrderListQuery, can, orderEmptyBody, orderNotifyBody, orderPatchBody, resendEmailBody, type Permission,
} from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import type { Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { recordAudit } from '../admin/router.js';
import { validate } from '../middleware/validate.js';
import { AdminOrderService, type Actor } from './admin-service.js';
import { renderPackingSlip } from './packing-slip.js';

type AdminRoutes = { routes: Router; can: (p: Permission) => RequestHandler };
const idParam = z.strictObject({ id: z.coerce.number().int().positive().max(2_147_483_647) });

export function registerOrderRoutes(admin: AdminRoutes, prisma: PrismaClient, service = new AdminOrderService(prisma)): void {
  const r = admin.routes;
  const read = admin.can('orders:read');
  const fulfil = admin.can('orders:fulfil');
  const noStore = (res: Response) => res.set('Cache-Control', 'private, no-store');
  const seeContact = (req: Request) => can(req.auth!.role, 'customers:write');
  const idOf = (req: Request) => (req.params as unknown as { id: number }).id;
  const actor = (req: Request, res: Response): Actor => ({
    userId: req.auth!.userId, seeContact: seeContact(req),
    audit: (db, e) => recordAudit(db, req, res, { action: e.action, entity: e.entity, entityId: e.entityId, before: e.before, after: e.after }),
  });

  r.get('/orders', read, validate({ query: adminOrderListQuery }), async (req, res) => {
    noStore(res).json(await service.list(req.query as unknown as z.output<typeof adminOrderListQuery>, seeContact(req)));
  });
  r.get('/orders/:id', read, validate({ params: idParam }), async (req, res) => {
    noStore(res).json(await service.detail(idOf(req), seeContact(req)));
  });
  r.get('/orders/:id/packing-slip', read, validate({ params: idParam }), async (req, res) => {
    const { order, store } = await service.packingSlip(idOf(req));
    const pdf = await renderPackingSlip(order, store);
    noStore(res).type('application/pdf').set('Content-Disposition', `inline; filename="packing-slip-${order.orderNumber}.pdf"`).send(pdf);
  });

  const notify = (req: Request) => (req.body as z.output<typeof orderNotifyBody>).notifyCustomer;
  r.post('/orders/:id/confirm', fulfil, validate({ params: idParam, body: orderNotifyBody }), async (req, res) => {
    noStore(res).json(await service.confirm(idOf(req), actor(req, res), notify(req)));
  });
  r.post('/orders/:id/pack', fulfil, validate({ params: idParam, body: orderEmptyBody }), async (req, res) => {
    noStore(res).json(await service.pack(idOf(req), actor(req, res)));
  });
  r.post('/orders/:id/out-for-delivery', fulfil, validate({ params: idParam, body: orderEmptyBody }), async (req, res) => {
    noStore(res).json(await service.outForDelivery(idOf(req), actor(req, res)));
  });
  r.post('/orders/:id/deliver', fulfil, validate({ params: idParam, body: orderNotifyBody }), async (req, res) => {
    noStore(res).json(await service.deliver(idOf(req), actor(req, res), notify(req)));
  });
  r.patch('/orders/:id', fulfil, validate({ params: idParam, body: orderPatchBody }), async (req, res) => {
    noStore(res).json(await service.patch(idOf(req), req.body as z.output<typeof orderPatchBody>, actor(req, res)));
  });
  r.post('/orders/:id/resend-email', fulfil, validate({ params: idParam, body: resendEmailBody }), async (req, res) => {
    noStore(res).json(await service.resendEmail(idOf(req), (req.body as z.output<typeof resendEmailBody>).template, actor(req, res)));
  });
}
