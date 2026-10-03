// /v1/me/* account endpoints (api.md §3.5, task 4.2): profile, password, email change, deletion, saved addresses and the
// wishlist. Bearer (storefront audience) on every route; never cached (cache policy). Endpoints that re-check the
// password share the per-IP login limit, so they cannot be used to guess it.
import {
  addressBody, changePasswordBody, deleteAccountBody, emailChangeBody, emailVerifyBody, MAX_ADDRESSES, profileBody, WISHLIST_MAX,
  wishlistMergeBody, wishlistToggleBody, type ProductCard,
} from '@artq/shared';
import { Prisma } from '@prisma/client';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { clearCookie, cookieSpec, type DeployEnv } from '../auth/cookies.js';
import { requireCustomer, type AuthDeps } from '../auth/middleware.js';
import type { AuthService } from '../auth/service.js';
import { AppError } from '../lib/errors.js';
import { RATE_LIMITS, rateLimit, type RateLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { productCards, type MediaUrl } from '../storefront/home.js';

export type AccountDeps = AuthDeps & { service: AuthService; env: DeployEnv; mediaUrl: MediaUrl; limiter?: RateLimiter; onRateLimitError?: (e: unknown) => void };
const idParam = z.strictObject({ id: z.coerce.number().int().positive() });
type Address = Prisma.AddressGetPayload<{ include: { state: true } }>;
/** The stored columns of an address body (empty optional lines become null). */
const columns = (b: z.output<typeof addressBody>) => ({
  label: b.label, fullName: b.fullName, phone: b.phone, line1: b.line1, line2: b.line2 ?? null, landmark: b.landmark ?? null, city: b.city, stateId: b.stateId, pincode: b.pincode,
});

export const addressView = (a: Address) => ({
  id: a.id, label: a.label, fullName: a.fullName, phone: a.phone, line1: a.line1, line2: a.line2, landmark: a.landmark,
  city: a.city, state: { id: a.state.id, name: a.state.name }, pincode: a.pincode, isDefault: a.isDefault,
});

export function accountRouter(d: AccountDeps): Router {
  const r = Router();
  const auth = requireCustomer(d);
  const uid = (req: Request) => req.auth!.userId;
  const passwordLimit = d.limiter ? rateLimit({ limiter: d.limiter, name: 'account-password', rule: RATE_LIMITS.login, ...(d.onRateLimitError ? { onError: d.onRateLimitError } : {}) }) : (_q: Request, _s: unknown, n: () => void) => n();
  const refreshCookie = cookieSpec('refresh', d.env);
  const field = (path: string, message: string) => new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path, message }]);

  // ── Profile, password, email, deletion ──
  r.patch('/me', auth, validate({ body: profileBody }), async (req, res) => { res.json({ user: await d.service.updateProfile(uid(req), req.body) }); });
  r.post('/me/password', auth, passwordLimit, validate({ body: changePasswordBody }), async (req, res) => {
    await d.service.changePassword(uid(req), req.body);
    res.setHeader('Set-Cookie', clearCookie(refreshCookie)).json({ ok: true });   // logged out everywhere, this browser too
  });
  r.post('/me/email/change', auth, passwordLimit, validate({ body: emailChangeBody }), async (req, res) => { res.json(await d.service.requestEmailChange(uid(req), req.body)); });
  r.post('/me/email/verify', auth, passwordLimit, validate({ body: emailVerifyBody }), async (req, res) => {
    const out = await d.service.verifyEmailChange(uid(req), req.body);
    res.setHeader('Set-Cookie', clearCookie(refreshCookie)).json(out);
  });
  r.delete('/me', auth, passwordLimit, validate({ body: deleteAccountBody }), async (req, res) => {
    await d.service.deleteAccount(uid(req), req.body);
    res.setHeader('Set-Cookie', clearCookie(refreshCookie)).json({ ok: true });
  });

  // ── Addresses ──
  /** A pincode in the postal directory must belong to the chosen state (a mistyped pincode or state is caught here). */
  const checkPlace = async (stateId: number, pincode: string) => {
    const state = await d.prisma.state.findFirst({ where: { id: stateId, isActive: true } });
    if (!state) throw field('stateId', 'Choose a state');
    const office = await d.prisma.postalCode.findFirst({ where: { pincode }, include: { state: true } });
    if (office && office.stateId !== stateId) throw field('pincode', `This pincode is in ${office.state.name}`);
    return state;
  };
  const list = (userId: number) => d.prisma.address.findMany({ where: { userId }, include: { state: true }, orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }] });

  r.get('/me/addresses', auth, async (req, res) => { res.json({ data: (await list(uid(req))).map(addressView) }); });
  r.post('/me/addresses', auth, validate({ body: addressBody }), async (req, res) => {
    const body = req.body as z.output<typeof addressBody>;
    const state = await checkPlace(body.stateId, body.pincode);
    const created = await d.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${uid(req)} FOR NO KEY UPDATE`;   // one change at a time per user
      const count = await tx.address.count({ where: { userId: uid(req) } });
      if (count >= MAX_ADDRESSES) throw new AppError(422, 'ADDRESS_LIMIT', `You can save up to ${MAX_ADDRESSES} addresses. Remove one first.`);
      const isDefault = count === 0 || body.isDefault === true;
      if (isDefault) await tx.address.updateMany({ where: { userId: uid(req) }, data: { isDefault: false } });
      return tx.address.create({ data: { ...columns(body), userId: uid(req), countryId: state.countryId, isDefault }, include: { state: true } });
    });
    res.status(201).json(addressView(created));
  });
  r.patch('/me/addresses/:id', auth, validate({ params: idParam, body: addressBody }), async (req, res) => {
    const id = (req.params as unknown as { id: number }).id;
    const body = req.body as z.output<typeof addressBody>;
    const state = await checkPlace(body.stateId, body.pincode);
    const updated = await d.prisma.$transaction(async (tx) => {
      const own = await tx.address.findFirst({ where: { id, userId: uid(req) } });
      if (!own) throw new AppError(404, 'NOT_FOUND', 'Address not found');
      if (body.isDefault) await tx.address.updateMany({ where: { userId: uid(req), id: { not: id } }, data: { isDefault: false } });
      // Unticking "default" on the default address is ignored: there is always one default while addresses exist.
      return tx.address.update({ where: { id }, data: { ...columns(body), countryId: state.countryId, ...(body.isDefault ? { isDefault: true } : {}) }, include: { state: true } });
    });
    res.json(addressView(updated));
  });
  r.post('/me/addresses/:id/default', auth, validate({ params: idParam }), async (req, res) => {
    const id = (req.params as unknown as { id: number }).id;
    await d.prisma.$transaction(async (tx) => {
      if (!(await tx.address.findFirst({ where: { id, userId: uid(req) } }))) throw new AppError(404, 'NOT_FOUND', 'Address not found');
      await tx.address.updateMany({ where: { userId: uid(req) }, data: { isDefault: false } });
      await tx.address.update({ where: { id }, data: { isDefault: true } });
    });
    res.json({ data: (await list(uid(req))).map(addressView) });
  });
  r.delete('/me/addresses/:id', auth, validate({ params: idParam }), async (req, res) => {
    const id = (req.params as unknown as { id: number }).id;
    await d.prisma.$transaction(async (tx) => {
      const own = await tx.address.findFirst({ where: { id, userId: uid(req) } });
      if (!own) throw new AppError(404, 'NOT_FOUND', 'Address not found');
      await tx.address.delete({ where: { id } });
      if (own.isDefault) {   // the most recently updated remaining address becomes the default
        const next = await tx.address.findFirst({ where: { userId: uid(req) }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }] });
        if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });
    res.json({ data: (await list(uid(req))).map(addressView) });
  });

  // ── Wishlist (newest first; at most 100; only products that still exist) ──
  const wishlist = async (userId: number): Promise<{ productIds: number[]; data: ProductCard[] }> => {
    const rows = await d.prisma.wishlistItem.findMany({ where: { userId, product: { deletedAt: null } }, orderBy: [{ createdAt: 'desc' }, { productId: 'desc' }], select: { productId: true } });
    const ids = rows.map((x) => x.productId);
    const data = ids.length ? await productCards(d.prisma, Prisma.sql`p.id = ANY(${ids})`, Prisma.sql`array_position(${ids}::int[], p.id)`, ids.length, d.mediaUrl) : [];
    return { productIds: ids, data };
  };
  const trim = async (userId: number) => {
    await d.prisma.$executeRaw`DELETE FROM wishlist_items WHERE user_id = ${userId} AND product_id NOT IN (
      SELECT product_id FROM wishlist_items WHERE user_id = ${userId} ORDER BY created_at DESC, product_id DESC LIMIT ${WISHLIST_MAX})`;
  };
  r.get('/me/wishlist', auth, async (req, res) => { res.json(await wishlist(uid(req))); });
  r.post('/me/wishlist/toggle', auth, validate({ body: wishlistToggleBody }), async (req, res) => {
    const { productId } = req.body as { productId: number };
    if (!(await d.prisma.product.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true } }))) throw new AppError(404, 'NOT_FOUND', 'Product not found');
    const removed = await d.prisma.wishlistItem.deleteMany({ where: { userId: uid(req), productId } });
    if (removed.count === 0) {
      await d.prisma.$executeRaw`INSERT INTO wishlist_items (user_id, product_id) VALUES (${uid(req)}, ${productId}) ON CONFLICT DO NOTHING`;
      await trim(uid(req));
    }
    res.json({ saved: removed.count === 0, ...(await wishlist(uid(req))) });
  });
  /** After login: the guest wishlist (kept in the browser) joins the account's; unknown or deleted products are skipped. */
  r.post('/me/wishlist/merge', auth, validate({ body: wishlistMergeBody }), async (req, res) => {
    const ids = [...new Set((req.body as { productIds: number[] }).productIds)];
    if (ids.length) {
      await d.prisma.$executeRaw`INSERT INTO wishlist_items (user_id, product_id)
        SELECT ${uid(req)}, p.id FROM products p WHERE p.id = ANY(${ids}) AND p.deleted_at IS NULL ON CONFLICT DO NOTHING`;
      await trim(uid(req));
    }
    res.json(await wishlist(uid(req)));
  });
  return r;
}
