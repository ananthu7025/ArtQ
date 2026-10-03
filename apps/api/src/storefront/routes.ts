// Public storefront content (api.md §3.1) and the newsletter sign-up (§3.2). The two GETs are on the public cache
// allow-list (architecture.md §8): shared caches may keep them 60 s; they never set or read cookies.
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { DEFAULT_SETTINGS, newsletterSubscribeBody, PUBLIC_SETTING_KEYS, settingSchemas, toPublicSettings, type Navigation, type PublicSettings, type SettingKey, type SettingValue } from '@artq/shared';
import { Router, type RequestHandler, type Response } from 'express';
import { RATE_LIMITS, rateLimit, type RateLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';

export const PUBLIC_CACHE = 'public, max-age=0, s-maxage=60, stale-while-revalidate=60';
const cacheable = (res: Response) => res.set('Cache-Control', PUBLIC_CACHE).set('Vary', 'Accept-Encoding');

export type StorefrontDeps = { prisma: PrismaClient; limiter?: RateLimiter; onRateLimitError?: (e: unknown) => void; onInvalidSetting?: (key: SettingKey) => void };

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

  r.get('/navigation', async (_req, res) => { cacheable(res).json(await loadNavigation(d.prisma)); });
  r.get('/settings/public', async (_req, res) => { cacheable(res).json(await loadPublicSettings(d.prisma, d.onInvalidSetting)); });

  // 201 SUBSCRIBED for a new (or returning, previously unsubscribed) address, 200 ALREADY_SUBSCRIBED otherwise (api.md §3.2).
  r.post('/newsletter/subscribe', formLimit, validate({ body: newsletterSubscribeBody }), async (req, res) => {
    const { email, source } = req.body as { email: string; source: string };
    const rows = await d.prisma.$queryRaw<{ created: boolean }[]>`
      INSERT INTO newsletter_subscribers (email, source, unsubscribe_token) VALUES (${email}, ${source}, ${randomBytes(16).toString('hex')})
      ON CONFLICT (email) DO UPDATE SET status = 'SUBSCRIBED', unsubscribed_at = NULL
        WHERE newsletter_subscribers.status <> 'SUBSCRIBED'
      RETURNING true AS created`;
    const created = rows.length > 0;
    res.status(created ? 201 : 200).set('Cache-Control', 'no-store').json({ status: created ? 'SUBSCRIBED' : 'ALREADY_SUBSCRIBED' });
  });
  return r;
}
