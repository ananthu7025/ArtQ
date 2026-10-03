// /v1/cart (api.md §3.7) and the cart's coupon (task 4.3). The cart cookie is created on the first add; reading without a cart returns an empty cart and
// sets nothing. Every response is the re-priced CartView (no-store via the cache policy).
import { cartAddBody, cartCouponBody, cartUpdateBody, checkoutQuoteBody, pincodeField } from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { cookieSpec, parseCookies, setCookie, type DeployEnv } from '../auth/cookies.js';
import { optionalCustomer, type AuthDeps } from '../auth/middleware.js';
import { AppError } from '../lib/errors.js';
import { RATE_LIMITS, rateLimit, type RateLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import type { MediaUrl } from '../storefront/home.js';
import { CART_TTL_S, CartService, hashToken } from './service.js';

const itemParam = z.strictObject({ itemId: z.coerce.number().int().positive() });
/** `?pincode=` on any cart call adds the shipping estimate for that pincode (task 4.5). */
const cartQuery = z.strictObject({ pincode: pincodeField.optional() });
const pin = (req: Request) => (req.query as { pincode?: string }).pincode ?? null;

export function cartRouter(d: AuthDeps & { env: DeployEnv; mediaUrl: MediaUrl; limiter?: RateLimiter; onRateLimitError?: (e: unknown) => void }): Router {
  const r = Router();
  r.use('/cart', optionalCustomer(d));
  const spec = cookieSpec('cart', d.env);
  const carts = new CartService(d.prisma, d.mediaUrl);
  const token = (req: Request) => parseCookies(req.get('cookie')).get(spec.name);
  /**
   * The caller's cart. Signed in: the account's cart (a guest cart in this browser is claimed into it first). Guest: the
   * cookie's cart, created (with its cookie) when `create` and there is none. Every guest write renews the 30-day cookie.
   */
  const cartFor = async (req: Request, res: Response, create: boolean): Promise<number | null> => {
    const t = token(req);
    if (req.auth) {
      const id = await carts.claim(t, req.auth.userId);
      if (id !== null || !create) return id;
      return (await carts.create(req.auth.userId)).id;
    }
    const found = await carts.find(t);
    if (found) { if (create) res.append('Set-Cookie', setCookie(spec, t!, CART_TTL_S)); return found.id; }
    if (!create) return null;
    const made = await carts.create();
    res.append('Set-Cookie', setCookie(spec, made.token, CART_TTL_S));
    return made.id;
  };
  const notInCart = () => new AppError(404, 'NOT_FOUND', 'This item is no longer in your cart');

  r.get('/cart', validate({ query: cartQuery }), async (req, res) => { res.json(await carts.view(await cartFor(req, res, false), pin(req))); });
  r.post('/cart/items', validate({ query: cartQuery, body: cartAddBody }), async (req, res) => {
    const { variantId, quantity } = req.body as z.infer<typeof cartAddBody>;
    const id = await cartFor(req, res, true);
    await carts.add(id!, variantId, quantity);
    res.status(201).json(await carts.view(id, pin(req)));
  });
  r.patch('/cart/items/:itemId', validate({ params: itemParam, query: cartQuery, body: cartUpdateBody }), async (req, res) => {
    const id = await cartFor(req, res, false);
    if (id === null) throw notInCart();
    await carts.update(id, (req.params as unknown as { itemId: number }).itemId, (req.body as { quantity: number }).quantity);
    res.json(await carts.view(id, pin(req)));
  });
  r.delete('/cart/items/:itemId', validate({ params: itemParam, query: cartQuery }), async (req, res) => {
    const id = await cartFor(req, res, false);
    if (id === null) throw notInCart();
    await carts.remove(id, (req.params as unknown as { itemId: number }).itemId);
    res.json(await carts.view(id, pin(req)));
  });
  // Coupons (task 4.3): checked now, reserved only at checkout. Applying is rate limited per IP so codes cannot be guessed.
  const couponLimit = d.limiter ? rateLimit({ limiter: d.limiter, name: 'cart-coupon', rule: RATE_LIMITS.couponApply, ...(d.onRateLimitError ? { onError: d.onRateLimitError } : {}) }) : (_q: Request, _s: Response, n: () => void) => n();
  r.post('/cart/coupon', couponLimit, validate({ query: cartQuery, body: cartCouponBody }), async (req, res) => {
    res.json(await carts.applyCoupon(await cartFor(req, res, false), (req.body as { code: string }).code, pin(req)));
  });
  r.delete('/cart/coupon', validate({ query: cartQuery }), async (req, res) => { res.json(await carts.removeCoupon(await cartFor(req, res, false), pin(req))); });
  r.get('/cart/coupons', async (req, res) => { res.json({ data: await carts.publicCoupons(await cartFor(req, res, false)) }); });
  // Checkout quote (task 4.6). Same cart resolution; limited per cart (signed in: per account) like every /checkout call.
  r.use('/checkout', optionalCustomer(d));
  const checkoutLimit = d.limiter ? rateLimit({ limiter: d.limiter, name: 'checkout', rule: RATE_LIMITS.checkout, key: async (req) => (req.auth ? `u:${req.auth.userId}` : token(req) ? `c:${hashToken(token(req)!)}` : null), ...(d.onRateLimitError ? { onError: d.onRateLimitError } : {}) }) : (_q: Request, _s: Response, n: () => void) => n();
  r.post('/checkout/quote', checkoutLimit, validate({ body: checkoutQuoteBody }), async (req, res) => {
    res.json(await carts.quote(await cartFor(req, res, false), req.auth?.userId ?? null, req.body as z.output<typeof checkoutQuoteBody>));
  });
  r.delete('/cart', validate({ query: cartQuery }), async (req, res) => {
    const id = await cartFor(req, res, false);
    if (id !== null) await carts.clear(id);
    res.json(await carts.view(id, pin(req)));
  });
  return r;
}

/** For the auth router: after any sign-in, the guest cart in this browser (cookie) joins the account. */
export function claimGuestCartOnSignIn(d: { prisma: PrismaClient; env: DeployEnv; mediaUrl: MediaUrl }) {
  const spec = cookieSpec('cart', d.env);
  const carts = new CartService(d.prisma, d.mediaUrl);
  return async (req: Request, userId: number) => { await carts.claim(parseCookies(req.get('cookie')).get(spec.name), userId); };
}
