// CMS & Messages endpoints (task 6.1; api.md §4.10 "CMS") [content:write].
//   GET/POST /admin/home-slides · PUT/DELETE /admin/home-slides/:id · PATCH /admin/home-slides/reorder      (same for
//   /admin/reels, /admin/testimonials, /admin/faqs; FAQs reorder within one group)
//   GET/POST /admin/pages · GET/PUT/DELETE /admin/pages/:id
//   GET /admin/cms/settings · PUT /admin/settings/:key (ANNOUNCEMENT_BAR, HOME_SECTIONS, HERO, INSTAGRAM_MOMENTS, SOCIAL)
//   GET /admin/messages?kind=&status=&open=1&q= · GET /admin/messages/:id · PATCH /admin/messages/:id {status?, adminNote?}
import {
  CMS_SETTING_BODIES, cmsReorderBody, faqBody, messageListQuery, messagePatchBody, pageBody, reelBody, slideBody, testimonialBody,
  type CmsSettingKey, type Permission, type Role,
} from '@artq/shared';
import type { Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { recordAudit } from '../admin/router.js';
import type { MediaService } from '../media/service.js';
import { validate } from '../middleware/validate.js';
import type { Audit, CmsService, Sortable } from './service.js';

type AdminRoutes = { routes: Router; can: (p: Permission) => RequestHandler };
const idParam = z.strictObject({ id: z.coerce.number().int().positive().max(2_147_483_647) });
const BODIES: Record<Sortable, z.ZodType> = { slides: slideBody, reels: reelBody, testimonials: testimonialBody, faqs: faqBody };
const PATHS: Record<Sortable, string> = { slides: '/home-slides', reels: '/reels', testimonials: '/testimonials', faqs: '/faqs' };

export function registerCmsRoutes(admin: AdminRoutes, service: CmsService, media: Pick<MediaService, 'privateUrl'>): void {
  const r = admin.routes;
  const write = admin.can('content:write');
  const noStore = (res: Response) => res.set('Cache-Control', 'private, no-store');
  const id = (req: Request) => (req.params as unknown as { id: number }).id;
  const audit = (req: Request, res: Response): Audit => (tx, e) => recordAudit(tx, req, res, e);

  for (const k of Object.keys(PATHS) as Sortable[]) {
    const path = PATHS[k];
    const list = () => service.list(k as never) as Promise<unknown[]>;
    r.get(path, write, async (_req, res) => { noStore(res).json({ data: await list() }); });
    // Before `/:id`, so "reorder" is never read as an id.
    r.patch(`${path}/reorder`, write, validate({ body: cmsReorderBody }), async (req, res) => {
      await service.reorder(k, (req.body as z.output<typeof cmsReorderBody>).ids, audit(req, res));
      noStore(res).json({ data: await list() });
    });
    r.post(path, write, validate({ body: BODIES[k] }), async (req, res) => {
      const newId = await service.create(k, req.body, audit(req, res));
      res.status(201);
      noStore(res).json({ id: newId, data: await list() });
    });
    r.put(`${path}/:id`, write, validate({ params: idParam, body: BODIES[k] }), async (req, res) => {
      await service.update(k, id(req), req.body, audit(req, res));
      noStore(res).json({ data: await list() });
    });
    r.delete(`${path}/:id`, write, validate({ params: idParam }), async (req, res) => {
      await service.remove(k, id(req), audit(req, res));
      noStore(res).json({ data: await list() });
    });
  }

  r.get('/pages', write, async (_req, res) => { noStore(res).json({ data: await service.pages() }); });
  r.get('/pages/:id', write, validate({ params: idParam }), async (req, res) => { noStore(res).json(await service.page(id(req))); });
  r.post('/pages', write, validate({ body: pageBody }), async (req, res) => {
    const newId = await service.savePage(null, req.body as z.output<typeof pageBody>, req.auth!.userId, audit(req, res));
    res.status(201);
    noStore(res).json(await service.page(newId));
  });
  r.put('/pages/:id', write, validate({ params: idParam, body: pageBody }), async (req, res) => {
    await service.savePage(id(req), req.body as z.output<typeof pageBody>, req.auth!.userId, audit(req, res));
    noStore(res).json(await service.page(id(req)));
  });
  r.delete('/pages/:id', write, validate({ params: idParam }), async (req, res) => {
    await service.removePage(id(req), audit(req, res));
    res.status(204).end();
  });

  r.get('/cms/settings', write, async (_req, res) => { noStore(res).json(await service.settings()); });
  for (const key of Object.keys(CMS_SETTING_BODIES) as CmsSettingKey[]) {
    r.put(`/settings/${key}`, write, validate({ body: CMS_SETTING_BODIES[key] }), async (req, res) => {
      await service.saveSetting(key, req.body, req.auth!.userId, audit(req, res));
      noStore(res).json(await service.settings());
    });
  }

  r.get('/messages', write, validate({ query: messageListQuery }), async (req, res) => { noStore(res).json(await service.messages(req.query as unknown as z.output<typeof messageListQuery>)); });
  r.get('/messages/:id', write, validate({ params: idParam }), async (req, res) => {
    const actor = { userId: req.auth!.userId, audience: 'admin' as const, role: req.auth!.role as Role };
    noStore(res).json(await service.message(id(req), (mediaId, w) => media.privateUrl(mediaId, actor, w)));
  });
  r.patch('/messages/:id', write, validate({ params: idParam, body: messagePatchBody }), async (req, res) => {
    await service.patchMessage(id(req), req.body as z.output<typeof messagePatchBody>, audit(req, res));
    const actor = { userId: req.auth!.userId, audience: 'admin' as const, role: req.auth!.role as Role };
    noStore(res).json(await service.message(id(req), (mediaId, w) => media.privateUrl(mediaId, actor, w)));
  });
}
