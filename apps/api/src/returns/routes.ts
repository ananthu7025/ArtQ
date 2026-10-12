// Return endpoints (task 5.5; api.md §3.5 and §4.7).
// Customer (the signed-in owner; the guest routes need the order access cookie from task 5.7):
//   POST /me/orders/:orderNumber/uploads/presign            a return photo (private image, scope return:<order id>)
//   POST /me/orders/:orderNumber/uploads/:mediaId/complete
//   POST /me/orders/:orderNumber/returns                     Idempotency-Key (return.create, target order:<number>)
// Staff:
//   GET  /admin/returns?status=&open=1&orderId=  · /admin/returns/:id      returns:receive (photos as 5-minute links)
//   POST /admin/returns/:id/decide · /close · /cancel                     returns:decide
//   POST /admin/returns/:id/in-transit · /receive · /inspect              returns:receive
//   POST /admin/returns/:id/refund                                        refunds:create + step-up, Idempotency-Key
import {
  customerReturnBody, returnCancelBody, returnDecideBody, returnInspectBody, returnListQuery, returnNoteBody, returnPhotoPresignBody, returnReceiveBody,
  returnRefundBody, type Permission, type Role,
} from '@artq/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';
import { recordAudit } from '../admin/router.js';
import { requireCustomer, type AuthDeps } from '../auth/middleware.js';
import { idempotent } from '../idempotency/idempotency.js';
import { AppError } from '../lib/errors.js';
import type { MediaService } from '../media/service.js';
import { validate } from '../middleware/validate.js';
import { ReturnService, type PhotoUrl } from './service.js';

type AdminRoutes = { routes: Router; can: (p: Permission, o?: { stepUp?: boolean }) => RequestHandler };
const idParam = z.strictObject({ id: z.coerce.number().int().positive().max(2_147_483_647) });
const orderParam = z.strictObject({ orderNumber: z.string().regex(/^[A-Za-z0-9-]{3,20}$/) });
const uploadParam = orderParam.extend({ mediaId: z.coerce.number().int().positive().max(2_147_483_647) });
const noStore = (res: Response) => res.set('Cache-Control', 'private, no-store');

export function registerReturnRoutes(admin: AdminRoutes, prisma: PrismaClient, log: Logger, media: Pick<MediaService, 'privateUrl'>, service = new ReturnService(prisma)): void {
  const r = admin.routes;
  const receive = admin.can('returns:receive');
  const decide = admin.can('returns:decide');
  const id = (req: Request) => (req.params as unknown as { id: number }).id;
  const photos = (req: Request): PhotoUrl => (mediaId, w) => media.privateUrl(mediaId, { userId: req.auth!.userId, audience: 'admin', role: req.auth!.role as Role }, w);
  const audit = (req: Request, res: Response) => (tx: Prisma.TransactionClient, e: { action: string; before?: unknown; after?: unknown }) =>
    recordAudit(tx, req, res, { action: e.action, entity: 'return', entityId: id(req), before: e.before, after: e.after });
  const send = async (req: Request, res: Response) => { noStore(res).json(await service.detail(id(req), photos(req))); };
  const body = <T>(req: Request) => req.body as T;

  r.get('/returns', receive, validate({ query: returnListQuery }), async (req, res) => { noStore(res).json(await service.list(req.query as unknown as z.output<typeof returnListQuery>)); });
  r.get('/returns/:id', receive, validate({ params: idParam }), send);
  r.post('/returns/:id/decide', decide, validate({ params: idParam, body: returnDecideBody }), async (req, res) => {
    await service.decide(id(req), body<z.output<typeof returnDecideBody>>(req), req.auth!.userId, audit(req, res)); await send(req, res);
  });
  r.post('/returns/:id/in-transit', receive, validate({ params: idParam, body: returnNoteBody }), async (req, res) => {
    await service.inTransit(id(req), body<z.output<typeof returnNoteBody>>(req).note, req.auth!.userId, audit(req, res)); await send(req, res);
  });
  r.post('/returns/:id/receive', receive, validate({ params: idParam, body: returnReceiveBody }), async (req, res) => {
    await service.receive(id(req), body<z.output<typeof returnReceiveBody>>(req), req.auth!.userId, audit(req, res)); await send(req, res);
  });
  r.post('/returns/:id/inspect', receive, validate({ params: idParam, body: returnInspectBody }), async (req, res) => {
    await service.inspect(id(req), body<z.output<typeof returnInspectBody>>(req), req.auth!.userId, audit(req, res)); await send(req, res);
  });
  r.post('/returns/:id/close', decide, validate({ params: idParam, body: returnNoteBody }), async (req, res) => {
    await service.close(id(req), body<z.output<typeof returnNoteBody>>(req).note, req.auth!.userId, audit(req, res)); await send(req, res);
  });
  r.post('/returns/:id/cancel', decide, validate({ params: idParam, body: returnCancelBody }), async (req, res) => {
    await service.cancel(id(req), body<z.output<typeof returnCancelBody>>(req).note, req.auth!.userId, audit(req, res)); await send(req, res);
  });
  r.post('/returns/:id/refund', admin.can('refunds:create'), validate({ params: idParam, body: returnRefundBody }), async (req, res, next) => {
    // The idempotency target is the order (like every refund of it); look it up before the key is taken.
    const ret = await prisma.returnRequest.findUnique({ where: { id: id(req) }, select: { orderId: true } });
    if (!ret) throw new AppError(404, 'NOT_FOUND', 'Return not found');
    return idempotent({ prisma, log }, {
      operation: 'refund.create', scope: (q) => `staff:${q.auth!.userId}`, target: () => `order:${ret.orderId}`,
    }, async (q, ctx) => {
      const b = q.body as z.output<typeof returnRefundBody>;
      if (ctx.resume?.resourceType === 'refund') return { status: 201, body: { refundId: Number(ctx.resume.resourceId), status: 'REQUESTED' }, resource: { type: 'refund', id: ctx.resume.resourceId } };
      const out = await ctx.tx(async (tx) => {
        const created = await service.refund(tx, id(q), b, ctx.key, q.auth!.userId);
        await ctx.attach(tx, 'refund', String(created.refundId));
        await recordAudit(tx, q, q.res as Response, { action: 'refund.create', entity: 'refund', entityId: created.refundId, after: { returnId: id(q), orderId: ret.orderId, ...b, method: created.method } });
        return created;
      });
      return { status: 201, body: out, resource: { type: 'refund', id: String(out.refundId) } };
    })(req, res, next);
  });
}

export function customerReturnRouter(d: AuthDeps & { prisma: PrismaClient; log: Logger; media: Pick<MediaService, 'presign' | 'complete'> }, service = new ReturnService(d.prisma)): Router {
  const r = Router();
  const auth = requireCustomer(d);
  const num = (req: Request) => (req.params as { orderNumber: string }).orderNumber;
  /** The signed-in customer's own order, or 404 (never says whether someone else's exists). */
  const ownOrder = async (req: Request) => {
    const o = await d.prisma.order.findFirst({ where: { orderNumber: num(req), userId: req.auth!.userId }, select: { id: true, orderNumber: true } });
    if (!o) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    return o;
  };
  const actor = (req: Request, orderId: number) => ({ userId: req.auth!.userId, audience: 'customer' as const, scope: `return:${orderId}` });

  r.post('/me/orders/:orderNumber/uploads/presign', auth, validate({ params: orderParam, body: returnPhotoPresignBody }), async (req, res) => {
    const o = await ownOrder(req);
    const out = await d.media.presign({ ...(req.body as z.output<typeof returnPhotoPresignBody>), purpose: 'return-photo' }, actor(req, o.id));
    res.status(201).set('Cache-Control', 'no-store').json(out);
  });
  r.post('/me/orders/:orderNumber/uploads/:mediaId/complete', auth, validate({ params: uploadParam }), async (req, res) => {
    const o = await ownOrder(req);
    noStore(res).json({ media: await d.media.complete((req.params as unknown as { mediaId: number }).mediaId, actor(req, o.id)) });
  });
  r.post('/me/orders/:orderNumber/returns', auth, validate({ params: orderParam, body: customerReturnBody }), idempotent({ prisma: d.prisma, log: d.log }, {
    operation: 'return.create', scope: (req) => `user:${req.auth!.userId}`, target: (req) => `order:${num(req)}`,
  }, async (req, ctx) => {
    const o = await ownOrder(req);
    if (ctx.resume?.resourceType === 'return') return { status: 201, body: await service.customerView(Number(ctx.resume.resourceId)), resource: { type: 'return', id: ctx.resume.resourceId } };
    const out = await ctx.tx(async (tx) => {
      const view = await service.create(tx, o.id, req.auth!.userId, req.body as z.output<typeof customerReturnBody>);
      await ctx.attach(tx, 'return', String(view.id));
      return view;
    });
    return { status: 201, body: out, resource: { type: 'return', id: String(out.id) } };
  }));
  return r;
}
