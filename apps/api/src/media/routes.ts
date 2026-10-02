// Media endpoints (api.md §4.9 admin media, §3.5 /me/attachments). Customer upload presigns (custom work, return photos)
// arrive with the cart (task 4.1) and returns (Phase 5); MediaService already supports their scopes.
import type { Role } from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { recordAudit } from '../admin/router.js';
import { requireCustomer, type AuthDeps } from '../auth/middleware.js';
import { validate } from '../middleware/validate.js';
import { PURPOSES, type MediaService, type Purpose } from './service.js';

const ADMIN_PURPOSES = Object.entries(PURPOSES).filter(([, r]) => r.audience === 'admin').map(([k]) => k) as [Purpose, ...Purpose[]];
const idParam = z.strictObject({ id: z.coerce.number().int().positive() });
const presignBody = z.strictObject({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().toLowerCase().max(120),
  size: z.number().int().positive(),
  purpose: z.enum(ADMIN_PURPOSES),
});
const fileQuery = z.strictObject({ w: z.enum(['160', '320', '640', '960', '1280', '1600']).optional() });

type AdminRoutes = { routes: Router; can: (p: 'media:write') => RequestHandler };
const id = (req: Request) => (req.params as unknown as { id: number }).id;
const adminActor = (req: Request) => ({ userId: req.auth!.userId, audience: 'admin' as const, role: req.auth!.role as Role });

export function registerAdminMediaRoutes(admin: AdminRoutes, media: MediaService, prisma: PrismaClient): void {
  const r = admin.routes;
  r.post('/media/presign', admin.can('media:write'), validate({ body: presignBody }), async (req, res) => {
    const out = await media.presign(req.body, adminActor(req));
    await recordAudit(prisma, req, res, { action: 'media.presign', entity: 'media', entityId: out.media.id, after: { purpose: req.body.purpose, contentType: req.body.contentType, size: req.body.size } });
    res.status(201).set('Cache-Control', 'no-store').json(out);
  });
  r.post('/media/:id/complete', admin.can('media:write'), validate({ params: idParam }), async (req, res) => {
    const view = await media.complete(id(req), adminActor(req));
    await recordAudit(prisma, req, res, { action: 'media.complete', entity: 'media', entityId: view.id, after: { status: view.status } });
    res.json({ media: view });
  });
  r.post('/media/:id/retry', admin.can('media:write'), validate({ params: idParam }), async (req, res) => {
    const view = await media.retry(id(req));
    await recordAudit(prisma, req, res, { action: 'media.retry', entity: 'media', entityId: view.id });
    res.status(202).json({ media: view });
  });
  r.get('/media/:id', admin.can('media:write'), validate({ params: idParam }), async (req, res) => {
    const m = await prisma.media.findUnique({ where: { id: id(req) } });
    if (!m || m.deletedAt) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Media not found' } }); return; }
    res.set('Cache-Control', 'private, no-store').json({ media: media.view(m) });
  });
  // Private file: permission is decided per scope inside the service (imports, returns, custom work).
  r.get('/media/:id/file', validate({ params: idParam, query: fileQuery }), async (req, res) => {
    const url = await media.privateUrl(id(req), adminActor(req), (req.query as { w?: string }).w);
    res.set('Cache-Control', 'private, no-store').redirect(302, url);
  });
}

export function customerMediaRouter(deps: AuthDeps, media: MediaService): Router {
  const r = Router();
  r.get('/me/attachments/:id', requireCustomer(deps), validate({ params: idParam, query: fileQuery }), async (req, res) => {
    const url = await media.privateUrl(id(req), { userId: req.auth!.userId, audience: 'customer' }, (req.query as { w?: string }).w);
    res.set('Cache-Control', 'private, no-store').redirect(302, url);
  });
  return r;
}
