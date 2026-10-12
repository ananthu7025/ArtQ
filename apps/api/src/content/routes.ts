// Storefront content (task 6.2; api.md §3.1–3.2). Public reads (on the public cache allow-list):
//   GET /pages/:slug   a published page (About, the policies, any page staff add)
//   GET /faqs          active questions by group, in order
// Forms (5 a minute per IP; JSON only; saved to the admin Messages inbox; the visitor gets an acknowledgement and staff
// a notification by email):
//   POST /contact      {name, email, phone?, subject, message, orderNumber?}
//   POST /custom-work  {name, email, phone, details, message, attachmentMediaIds[]}
//   POST /uploads/presign · POST /uploads/:id/complete · GET /uploads/:id   custom-work photos (private images ≤ 8 MB)
// Photos belong to the visitor: a signed-in customer's own uploads, or a guest's (scope = their cart cookie, created
// if they have none); a custom-work request can only attach that visitor's READY, unattached photos.
import { contactBody, customWorkBody, FAQ_GROUP_LABEL, uploadPresignBody, type FaqView, type PublicPage } from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';
import { cookieSpec, parseCookies, setCookie, type DeployEnv } from '../auth/cookies.js';
import { optionalCustomer, type AuthDeps } from '../auth/middleware.js';
import { CART_TTL_S, CartService, hashToken } from '../cart/service.js';
import * as fn from '../db/functions.js';
import { AppError } from '../lib/errors.js';
import type { Actor, MediaService } from '../media/service.js';
import { rateLimit, RATE_LIMITS, type RateLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';

export type ContentDeps = AuthDeps & {
  prisma: PrismaClient; env: DeployEnv; log: Logger; media: Pick<MediaService, 'presign' | 'complete' | 'own' | 'claim'>; mediaUrl: (key: string) => string;
  limiter?: RateLimiter; onRateLimitError?: (e: unknown) => void;
};
const slugParam = z.strictObject({ slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80) });
const idParam = z.strictObject({ id: z.coerce.number().int().positive().max(2_147_483_647) });

export function contentRouter(d: ContentDeps): Router {
  const r = Router();
  const pass: RequestHandler = (_q, _s, n) => n();
  const formLimit: RequestHandler = d.limiter ? rateLimit({ limiter: d.limiter, name: 'public-form', rule: RATE_LIMITS.publicForm, ...(d.onRateLimitError ? { onError: d.onRateLimitError } : {}) }) : pass;
  const spec = cookieSpec('cart', d.env);
  const carts = new CartService(d.prisma, d.mediaUrl);

  r.get('/pages/:slug', validate({ params: slugParam }), async (req, res) => {
    const p = await d.prisma.cmsPage.findFirst({ where: { slug: (req.params as { slug: string }).slug, isPublished: true } });
    if (!p) throw new AppError(404, 'NOT_FOUND', 'Page not found');
    res.json({ slug: p.slug, title: p.title, content: p.content, metaTitle: p.metaTitle, metaDescription: p.metaDescription, updatedAt: p.updatedAt.toISOString() } satisfies PublicPage);
  });
  r.get('/faqs', async (_req, res) => {
    const rows = await d.prisma.faq.findMany({ where: { isActive: true }, orderBy: [{ group: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }] });
    const groups = (Object.keys(FAQ_GROUP_LABEL) as (keyof typeof FAQ_GROUP_LABEL)[]).map((g) => ({ group: g, label: FAQ_GROUP_LABEL[g], items: rows.filter((f) => f.group === g).map((f) => ({ question: f.question, answer: f.answer })) })).filter((g) => g.items.length > 0);
    res.json({ groups } satisfies FaqView);
  });

  // ── Forms ──
  r.use(['/contact', '/custom-work', '/uploads'], optionalCustomer(d));
  /** Who owns custom-work photos: the signed-in customer, else this browser's cart cookie (created when `create`). */
  const uploader = async (req: Request, res: Response, create: boolean): Promise<Actor | null> => {
    if (req.auth) return { userId: req.auth.userId, audience: 'customer', scope: `custom-work:user:${req.auth.userId}` };
    let t = parseCookies(req.get('cookie')).get(spec.name);
    if (!t || !(await carts.find(t))) {
      if (!create) return null;
      t = (await carts.create()).token;
      res.append('Set-Cookie', setCookie(spec, t, CART_TTL_S));
    }
    // The owner column holds 60 characters: 128 bits of the cookie's hash are plenty to stay unguessable.
    return { userId: null, audience: 'customer', scope: `custom-work:${hashToken(t).slice(0, 32)}` };
  };
  const noStore = (res: Response) => res.set('Cache-Control', 'private, no-store');
  /** One message event: an acknowledgement to the visitor and a notification to staff. */
  const notify = (tx: Parameters<typeof fn.emit>[0], id: number) => fn.emit(tx, { aggregateType: 'contact_message', aggregateId: String(id), type: 'message.received', payload: { message_id: id }, consumers: ['email.customer', 'email.admin'] });

  r.post('/contact', formLimit, validate({ body: contactBody }), async (req, res) => {
    const b = req.body as z.output<typeof contactBody>;
    const id = await d.prisma.$transaction(async (tx) => {
      const m = await tx.contactMessage.create({ data: { kind: 'CONTACT', name: b.name, email: b.email, phone: b.phone, subject: b.subject, message: b.message, orderNumber: b.orderNumber } });
      await notify(tx, m.id);
      return m.id;
    });
    res.status(201);
    noStore(res).json({ id, received: true });
  });

  r.post('/custom-work', formLimit, validate({ body: customWorkBody }), async (req, res) => {
    const b = req.body as z.output<typeof customWorkBody>;
    const actor = b.attachmentMediaIds.length ? await uploader(req, res, false) : null;
    if (b.attachmentMediaIds.length && !actor) throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'attachmentMediaIds', message: 'Upload the photos again' }]);
    const id = await d.prisma.$transaction(async (tx) => {
      for (const mediaId of b.attachmentMediaIds) {
        // Only this visitor's processed, unattached photos (claim also checks the scope).
        const own = await tx.media.findFirst({ where: { id: mediaId, ownerScope: actor!.scope!, uploadedBy: actor!.userId, claimedAt: null }, select: { id: true } });
        if (!own) throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'attachmentMediaIds', message: 'A photo is missing, still being processed, or already sent. Upload it again.' }]);
        try { await d.media.claim(tx, mediaId, actor!.scope!); }
        catch { throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'attachmentMediaIds', message: 'A photo is still being processed. Wait a moment and send again.' }]); }
      }
      const m = await tx.contactMessage.create({ data: {
        kind: 'CUSTOM_WORK', name: b.name, email: b.email, phone: b.phone, subject: 'Custom work request', message: b.message, details: b.details,
        attachments: { create: b.attachmentMediaIds.map((mediaId) => ({ mediaId })) },
      } });
      await notify(tx, m.id);
      return m.id;
    });
    res.status(201);
    noStore(res).json({ id, received: true });
  });

  r.post('/uploads/presign', formLimit, validate({ body: uploadPresignBody }), async (req, res) => {
    const actor = (await uploader(req, res, true))!;
    const out = await d.media.presign({ ...(req.body as z.output<typeof uploadPresignBody>), purpose: 'custom-work' }, actor);
    res.status(201);
    noStore(res).json(out);
  });
  r.post('/uploads/:id/complete', validate({ params: idParam }), async (req, res) => {
    const actor = await uploader(req, res, false);
    if (!actor) throw new AppError(404, 'NOT_FOUND', 'Media not found');
    noStore(res).json({ media: await d.media.complete((req.params as unknown as { id: number }).id, actor) });
  });
  r.get('/uploads/:id', validate({ params: idParam }), async (req, res) => {
    const actor = await uploader(req, res, false);
    if (!actor) throw new AppError(404, 'NOT_FOUND', 'Media not found');
    noStore(res).json({ media: await d.media.own((req.params as unknown as { id: number }).id, actor) });
  });
  return r;
}
