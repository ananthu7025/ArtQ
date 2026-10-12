// Customer and guest order endpoints (task 5.7; api.md §3.5–3.6, architecture.md §5.6). AT-12: the tracking link is
// read-only; every action needs the signed-in owner or the order access cookie from an email code for that order; the
// cookie opens one order only; another order's attachments are 404; private links expire after 5 minutes.
// Signed-in owner (Bearer):
//   GET  /me/orders · /me/orders/:n · /me/orders/:n/invoice · /me/orders/:n/uploads/:mediaId
//   (cancel, returns and photo uploads: cancel.ts and returns/routes.ts)
// Guest:
//   GET  /orders/track/:n?token=                         read-only (masked address, no actions, no photos)
//   POST /orders/:n/access/request {email}               a code if the email is the order's; always {sent: true}
//   POST /orders/:n/access/verify {email, code}          sets the order cookie (1 h) → the order
//   GET  /orders/:n · /orders/:n/invoice · /orders/:n/attachments/:mediaId
//   POST /orders/:n/cancel · /orders/:n/returns          Idempotency-Key (scope order:<number>)
//   POST /orders/:n/uploads/presign · /orders/:n/uploads/:mediaId/complete · GET /orders/:n/uploads/:mediaId
import { customerCancelOrderBody, customerOrderListQuery, customerReturnBody, orderAccessRequestBody, orderAccessVerifyBody, returnPhotoPresignBody, trackQuery } from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import { Router, type Request, type Response } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';
import { cookieSpec, setCookie, type DeployEnv } from '../auth/cookies.js';
import { optionalCustomer, requireCustomer, type AuthDeps } from '../auth/middleware.js';
import type { AuthService } from '../auth/service.js';
import { idempotent } from '../idempotency/idempotency.js';
import { AppError } from '../lib/errors.js';
import type { Actor, MediaService } from '../media/service.js';
import { rateLimit, RATE_LIMITS, type RateLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { ReturnService } from '../returns/service.js';
import { ORDER_ACCESS_TTL_S, orderAccessCookieValue, orderAccessFromCookie, trackingValid } from './access.js';
import { cancelOrder } from './cancel.js';
import { CustomerOrderService, type Access } from './customer.js';
import type { DispatchService } from './dispatch.js';

export type CustomerOrderDeps = AuthDeps & {
  prisma: PrismaClient; log: Logger; env: DeployEnv; linkSecret: string; auth: Pick<AuthService, 'requestOrderAccess' | 'verifyOrderAccess'>;
  media: Pick<MediaService, 'presign' | 'complete' | 'own' | 'privateUrl'>; dispatch: Pick<DispatchService, 'invoiceUrl'>;
  limiter?: RateLimiter; onRateLimitError?: (e: unknown) => void;
};

const orderParam = { orderNumber: z.string().regex(/^[A-Za-z0-9-]{3,20}$/) };

export function customerOrdersRouter(d: CustomerOrderDeps, service = new CustomerOrderService(d.prisma), returns = new ReturnService(d.prisma)): Router {
  const r = Router();
  const params = z.strictObject(orderParam);
  const mediaParams = z.strictObject({ ...orderParam, mediaId: z.coerce.number().int().positive().max(2_147_483_647) });
  const num = (req: Request) => (req.params as { orderNumber: string }).orderNumber;
  const mediaId = (req: Request) => (req.params as unknown as { mediaId: number }).mediaId;
  const noStore = (res: Response) => res.set('Cache-Control', 'private, no-store');
  const pass = (_q: Request, _s: Response, n: () => void) => n();
  const limit = (name: string, rule: { limit: number; windowS: number }) => (d.limiter ? rateLimit({ limiter: d.limiter, name, rule, ...(d.onRateLimitError ? { onError: d.onRateLimitError } : {}) }) : pass);
  const notFound = () => new AppError(404, 'NOT_FOUND', 'Order not found');

  /** Private photo links: the owner (or uploader) as a customer, a guest within the order's return scope. */
  const photoLink = (orderId: number, userId: number | null) => async (id: number) => {
    const actor: Actor = userId ? { userId, audience: 'customer' } : { userId: null, audience: 'customer', scope: `return:${orderId}` };
    try { return await d.media.privateUrl(id, actor, '640').catch(() => d.media.privateUrl(id, actor)); } catch { return null; }
  };

  // ── Signed-in owner ──
  const owner = requireCustomer(d);
  const ownOrder = async (req: Request) => {
    const o = await d.prisma.order.findFirst({ where: { orderNumber: num(req), userId: req.auth!.userId }, select: { id: true, orderNumber: true } });
    if (!o) throw notFound();
    return o;
  };
  r.get('/me/orders', owner, validate({ query: customerOrderListQuery }), async (req, res) => {
    noStore(res).json(await service.list(req.auth!.userId, req.query as unknown as z.output<typeof customerOrderListQuery>));
  });
  r.get('/me/orders/:orderNumber', owner, validate({ params }), async (req, res) => {
    const o = await ownOrder(req);
    noStore(res).json(await service.view(o.id, 'owner', photoLink(o.id, req.auth!.userId)));
  });
  r.get('/me/orders/:orderNumber/invoice', owner, validate({ params }), async (req, res) => { noStore(res).json(await d.dispatch.invoiceUrl((await ownOrder(req)).id)); });
  r.get('/me/orders/:orderNumber/uploads/:mediaId', owner, validate({ params: mediaParams }), async (req, res) => {
    const o = await ownOrder(req);
    noStore(res).json({ media: await d.media.own(mediaId(req), { userId: req.auth!.userId, audience: 'customer', scope: `return:${o.id}` }) });
  });

  // ── Guests ──
  r.use('/orders', optionalCustomer(d));
  const byNumber = async (req: Request) => {
    const o = await d.prisma.order.findUnique({ where: { orderNumber: num(req) } });
    if (!o) throw notFound();
    return o;
  };
  /** The order this request may act on: the order cookie for this order, or its signed-in owner. Else 404. */
  const guestOrder = async (req: Request): Promise<{ id: number; orderNumber: string; userId: number | null; access: Access }> => {
    const o = await byNumber(req);
    if (orderAccessFromCookie(req, d.env, d.linkSecret) === o.id) return { id: o.id, orderNumber: o.orderNumber, userId: null, access: 'guest' };
    if (o.userId !== null && req.auth?.userId === o.userId) return { id: o.id, orderNumber: o.orderNumber, userId: o.userId, access: 'owner' };
    throw notFound();
  };
  const guestActor = (o: { id: number }): Actor => ({ userId: null, audience: 'customer', scope: `return:${o.id}` });

  r.get('/orders/track/:orderNumber', validate({ params, query: trackQuery }), async (req, res) => {
    const o = await d.prisma.order.findUnique({ where: { orderNumber: num(req) } });
    if (!o || o.status === 'PENDING_PAYMENT' || !trackingValid(d.linkSecret, o, (req.query as { token: string }).token)) throw new AppError(404, 'NOT_FOUND', 'This tracking link is not valid or has expired.');
    noStore(res).json(await service.view(o.id, 'tracking', async () => null));
  });
  r.post('/orders/:orderNumber/access/request', limit('order-access-email', RATE_LIMITS.emailSend), validate({ params, body: orderAccessRequestBody }), async (req, res) => {
    const o = await d.prisma.order.findUnique({ where: { orderNumber: num(req) }, select: { id: true } });
    const out = o ? await d.auth.requestOrderAccess(o.id, (req.body as z.output<typeof orderAccessRequestBody>).email) : { sent: true as const, resendAfter: 30 };
    noStore(res).json(out);                                                   // the same answer whether or not it matched
  });
  r.post('/orders/:orderNumber/access/verify', limit('order-access-verify', RATE_LIMITS.verify), validate({ params, body: orderAccessVerifyBody }), async (req, res) => {
    const b = req.body as z.output<typeof orderAccessVerifyBody>;
    const o = await d.prisma.order.findUnique({ where: { orderNumber: num(req) }, select: { id: true } });
    if (!o) throw new AppError(422, 'OTP_INVALID', 'The code is not valid');
    await d.auth.verifyOrderAccess(o.id, b.email, b.code);
    noStore(res).setHeader('Set-Cookie', setCookie(cookieSpec('order', d.env), orderAccessCookieValue(d.linkSecret, o.id), ORDER_ACCESS_TTL_S));
    res.json(await service.view(o.id, 'guest', photoLink(o.id, null)));
  });
  r.get('/orders/:orderNumber', validate({ params }), async (req, res) => {
    const o = await guestOrder(req);
    noStore(res).json(await service.view(o.id, o.access, photoLink(o.id, o.userId)));
  });
  r.get('/orders/:orderNumber/invoice', validate({ params }), async (req, res) => { noStore(res).json(await d.dispatch.invoiceUrl((await guestOrder(req)).id)); });
  r.get('/orders/:orderNumber/attachments/:mediaId', validate({ params: mediaParams }), async (req, res) => {
    const o = await guestOrder(req);
    // Only a photo attached to one of this order's returns; anything else (another order's, unattached) is 404.
    const attached = await d.prisma.returnRequestMedia.findFirst({ where: { mediaId: mediaId(req), returnRequest: { orderId: o.id } }, select: { mediaId: true } });
    const url = attached ? await photoLink(o.id, o.userId)(mediaId(req)) : null;
    if (!url) throw new AppError(404, 'NOT_FOUND', 'Media not found');
    noStore(res).redirect(302, url);
  });
  r.post('/orders/:orderNumber/cancel', validate({ params, body: customerCancelOrderBody }), idempotent({ prisma: d.prisma, log: d.log }, {
    operation: 'order.cancel', scope: (req) => `order:${num(req)}`, target: (req) => `order:${num(req)}`,
  }, async (req, ctx) => {
    const o = await guestOrder(req);
    const out = await cancelOrder(d.prisma, ctx, o.id, { by: 'CUSTOMER', actorId: req.auth?.userId ?? null }, (req.body as z.output<typeof customerCancelOrderBody>).reason, true);
    return { status: 200, body: out, resource: { type: 'order', id: out.orderNumber } };
  }));
  r.post('/orders/:orderNumber/returns', validate({ params, body: customerReturnBody }), idempotent({ prisma: d.prisma, log: d.log }, {
    operation: 'return.create', scope: (req) => `order:${num(req)}`, target: (req) => `order:${num(req)}`,
  }, async (req, ctx) => {
    const o = await guestOrder(req);
    if (ctx.resume?.resourceType === 'return') return { status: 201, body: await returns.customerView(Number(ctx.resume.resourceId)), resource: { type: 'return', id: ctx.resume.resourceId } };
    const out = await ctx.tx(async (tx) => {
      const view = await returns.create(tx, o.id, o.access === 'owner' ? o.userId : null, req.body as z.output<typeof customerReturnBody>);
      await ctx.attach(tx, 'return', String(view.id));
      return view;
    });
    return { status: 201, body: out, resource: { type: 'return', id: String(out.id) } };
  }));
  const uploader = (o: { id: number; userId: number | null; access: Access }): Actor => (o.access === 'owner' ? { userId: o.userId, audience: 'customer', scope: `return:${o.id}` } : guestActor(o));
  r.post('/orders/:orderNumber/uploads/presign', limit('order-upload', RATE_LIMITS.publicForm), validate({ params, body: returnPhotoPresignBody }), async (req, res) => {
    const o = await guestOrder(req);
    res.status(201).set('Cache-Control', 'no-store').json(await d.media.presign({ ...(req.body as z.output<typeof returnPhotoPresignBody>), purpose: 'return-photo' }, uploader(o)));
  });
  r.post('/orders/:orderNumber/uploads/:mediaId/complete', validate({ params: mediaParams }), async (req, res) => {
    const o = await guestOrder(req);
    noStore(res).json({ media: await d.media.complete(mediaId(req), uploader(o)) });
  });
  r.get('/orders/:orderNumber/uploads/:mediaId', validate({ params: mediaParams }), async (req, res) => {
    const o = await guestOrder(req);
    noStore(res).json({ media: await d.media.own(mediaId(req), uploader(o)) });
  });
  return r;
}
