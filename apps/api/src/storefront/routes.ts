// Public storefront content (api.md §3.1) and the newsletter sign-up (§3.2). The two GETs are on the public cache
// allow-list (architecture.md §6.1; headers set by middleware/cachePolicy.ts) and kept in the Redis app cache.
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { DEFAULT_SETTINGS, newsletterSubscribeBody, notifyMeBody, pincodeField, storefrontListQuery, type StorefrontListQuery, PUBLIC_SETTING_KEYS, settingSchemas, toPublicSettings, type Navigation, type PublicSettings, type SettingKey, type SettingValue } from '@artq/shared';
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { noAppCache, type AppCache } from '../lib/app-cache.js';
import { loadHome, type MediaUrl } from './home.js';
import { cardsByIds, findLiveProduct, loadAvailability, loadProductDetail, loadRelated } from './products.js';
import { checkPincode } from './pincodes.js';
import { listProducts, loadTaxonomyPage } from './listing.js';
import { AppError } from '../lib/errors.js';
import { RATE_LIMITS, rateLimit, type RateLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';

export type StorefrontDeps = { prisma: PrismaClient; cache?: AppCache; mediaUrl: MediaUrl; limiter?: RateLimiter; onRateLimitError?: (e: unknown) => void; onInvalidSetting?: (key: SettingKey) => void };

/** Menu: active types with "show in menu", their active categories; a tile link override replaces the type page. */
export async function loadNavigation(prisma: PrismaClient): Promise<Navigation> {
  const types = await prisma.productType.findMany({
    where: { isActive: true, showInMenu: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, slug: true, tileLinkUrl: true, categories: { where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: { id: true, name: true, slug: true } } },
  });
  return { types: types.map((t) => ({ id: t.id, name: t.name, slug: t.slug, href: t.tileLinkUrl ?? `/type/${t.slug}`, categories: t.categories })) };
}

/** Public settings: each stored value is checked with its schema; an invalid one falls back to the launch default. */
export async function loadPublicSettings(prisma: PrismaClient, onInvalid?: (key: SettingKey) => void): Promise<PublicSettings> {
  const rows = await prisma.setting.findMany({ where: { key: { in: [...PUBLIC_SETTING_KEYS] }, isPublic: true } });
  const get = <K extends SettingKey>(key: K): SettingValue<K> => {
    const row = rows.find((r) => r.key === key);
    if (!row) return DEFAULT_SETTINGS[key];
    const parsed = settingSchemas[key].safeParse(row.value);
    if (parsed.success) return parsed.data as SettingValue<K>;
    onInvalid?.(key);
    return DEFAULT_SETTINGS[key];
  };
  return toPublicSettings(get);
}

export function storefrontRouter(d: StorefrontDeps): Router {
  const r = Router();
  const formLimit: RequestHandler = d.limiter
    ? rateLimit({ limiter: d.limiter, name: 'public-form', rule: RATE_LIMITS.publicForm, ...(d.onRateLimitError ? { onError: d.onRateLimitError } : {}) })
    : (_req, _res, next) => next();

  const cache = d.cache ?? noAppCache;
  r.get('/navigation', async (_req, res) => { res.json(await cache.get('navigation', () => loadNavigation(d.prisma))); });
  r.get('/home', async (_req, res) => { res.json(await loadHome(d.prisma, d.mediaUrl)); });
  r.get('/settings/public', async (_req, res) => { res.json(await cache.get('publicSettings', () => loadPublicSettings(d.prisma, d.onInvalidSetting))); });

  const slugParam = z.strictObject({ slug: z.string().min(1).max(220) });
  const notFound = () => new AppError(404, 'NOT_FOUND', 'This product is not available');
  /** Live product for :slug; an old slug answers 200 {redirectTo} (api.md §3.3); drafts/archived/unknown → 404. */
  const live = async (slug: string, res: Response): Promise<number | null> => {
    const found = await findLiveProduct(d.prisma, slug);
    if (!found) throw notFound();
    if ('redirectTo' in found) { res.json({ redirectTo: found.redirectTo }); return null; }
    return found.id;
  };
  r.get('/products', validate({ query: storefrontListQuery }), async (req, res) => { res.json(await listProducts(d.prisma, req.query as unknown as StorefrontListQuery, d.mediaUrl)); });
  for (const [kind, path] of [['type', '/types/:slug'], ['category', '/categories/:slug'], ['technique', '/techniques/:slug']] as const) {
    r.get(path, validate({ params: slugParam }), async (req, res) => {
      const page = await loadTaxonomyPage(d.prisma, kind, String(req.params.slug), d.mediaUrl);
      if (!page) throw new AppError(404, 'NOT_FOUND', `This ${kind} is not available`);
      res.json(page);
    });
  }
  // Before /products/:slug, so "by-ids" is never read as a slug.
  const idsQuery = z.strictObject({ ids: z.string().regex(/^\d{1,9}(,\d{1,9}){0,23}$/, 'Up to 24 product ids, comma-separated') });
  r.get('/products/by-ids', validate({ query: idsQuery }), async (req, res) => {
    const ids = [...new Set((req.query as unknown as { ids: string }).ids.split(',').map(Number))];
    res.json({ data: await cardsByIds(d.prisma, ids, d.mediaUrl) });
  });
  r.get('/products/:slug/related', validate({ params: slugParam }), async (req, res) => {
    const id = await live(String(req.params.slug), res);
    if (id !== null) res.json(await loadRelated(d.prisma, id, d.mediaUrl));
  });
  const pincodeParam = z.strictObject({ pincode: pincodeField });
  r.get('/pincodes/:pincode/serviceability', validate({ params: pincodeParam }), async (req, res) => {
    res.json(await checkPincode(d.prisma, (req.params as unknown as { pincode: string }).pincode));
  });
  r.get('/products/:slug', validate({ params: slugParam }), async (req, res) => {
    const id = await live(String(req.params.slug), res);
    if (id === null) return;
    const detail = await loadProductDetail(d.prisma, id, d.mediaUrl);
    if (!detail) throw notFound();
    res.json(detail);
  });
  r.get('/products/:slug/availability', validate({ params: slugParam }), async (req, res) => {
    const id = await live(String(req.params.slug), res);
    if (id !== null) res.json(await loadAvailability(d.prisma, id));
  });

  // "Notify me" (product.md §6): one pending request per size and email; only while that size is out of stock.
  r.post('/products/:slug/notify', formLimit, validate({ params: slugParam, body: notifyMeBody }), async (req, res) => {
    const { variantId, email } = req.body as z.infer<typeof notifyMeBody>;
    const found = await findLiveProduct(d.prisma, String(req.params.slug));
    if (!found || 'redirectTo' in found) throw notFound();
    const created = await d.prisma.$transaction(async (tx) => {
      const [v] = await tx.$queryRaw<{ available: number }[]>`SELECT GREATEST(on_hand - reserved, 0)::int AS available FROM product_variants
        WHERE id = ${variantId} AND product_id = ${found.id} AND is_active AND deleted_at IS NULL AND price IS NOT NULL`;
      if (!v) throw new AppError(404, 'NOT_FOUND', 'This option is not available');
      if (v.available > 0) throw new AppError(409, 'IN_STOCK', 'This option is in stock: you can add it to your cart now', { available: v.available });
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`notify:${variantId}:${email.toLowerCase()}`}))`;
      const pending = await tx.stockNotification.findFirst({ where: { variantId, email, status: 'PENDING' } });
      if (pending) return false;
      await tx.stockNotification.create({ data: { variantId, productId: found.id, email } });
      return true;
    });
    res.status(created ? 201 : 200).json({ status: created ? 'SUBSCRIBED' : 'ALREADY_SUBSCRIBED' });
  });

  // 201 SUBSCRIBED for a new (or returning, previously unsubscribed) address, 200 ALREADY_SUBSCRIBED otherwise (api.md §3.2).
  r.post('/newsletter/subscribe', formLimit, validate({ body: newsletterSubscribeBody }), async (req, res) => {
    const { email, source } = req.body as { email: string; source: string };
    const rows = await d.prisma.$queryRaw<{ created: boolean }[]>`
      INSERT INTO newsletter_subscribers (email, source, unsubscribe_token) VALUES (${email}, ${source}, ${randomBytes(16).toString('hex')})
      ON CONFLICT (email) DO UPDATE SET status = 'SUBSCRIBED', unsubscribed_at = NULL
        WHERE newsletter_subscribers.status <> 'SUBSCRIBED'
      RETURNING true AS created`;
    const created = rows.length > 0;
    res.status(created ? 201 : 200).json({ status: created ? 'SUBSCRIBED' : 'ALREADY_SUBSCRIBED' });
  });
  return r;
}
