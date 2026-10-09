// Who may see an order (architecture.md §5.6, task 5.7):
// - the tracking link in the order emails: `/track/<number>?token=<t>`, t = HMAC(link secret, number + the order's
//   tracking_token_hash). Nothing new is stored, and rotating the hash revokes every link. Read-only, until 90 days
//   after the order closed (completed, cancelled or expired).
// - the order access cookie (`aq_order`, Path=/v1/orders, 1 hour) after an email code for that order: a signed token
//   naming the order id, so it opens that one order only.
// - the signed-in owner (Bearer).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Order } from '@prisma/client';
import type { Request } from 'express';
import { cookieSpec, parseCookies, type DeployEnv } from '../auth/cookies.js';
import { signLink, verifyLink } from '../auth/tokens.js';

export const ORDER_ACCESS_TTL_S = 3600;
export const TRACKING_DAYS_AFTER_CLOSE = 90;

export function trackingToken(secret: string, o: Pick<Order, 'orderNumber' | 'trackingTokenHash'>): string {
  return createHmac('sha256', secret).update(`track:${o.orderNumber}:${o.trackingTokenHash}`).digest('base64url');
}

/** The token matches and the link has not run out (90 days after the order closed). */
export function trackingValid(secret: string, o: Pick<Order, 'orderNumber' | 'trackingTokenHash' | 'completedAt' | 'cancelledAt' | 'expiredAt'>, token: string, now = new Date()): boolean {
  const want = Buffer.from(trackingToken(secret, o));
  const got = Buffer.from(token);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
  const closed = o.completedAt ?? o.cancelledAt ?? o.expiredAt;
  return !closed || now.getTime() - closed.getTime() <= TRACKING_DAYS_AFTER_CLOSE * 86_400_000;
}

export const trackingUrl = (webUrl: string, secret: string, o: Pick<Order, 'orderNumber' | 'trackingTokenHash'>) =>
  `${webUrl.replace(/\/$/, '')}/track/${encodeURIComponent(o.orderNumber)}?token=${trackingToken(secret, o)}`;

/** Cookie value: the signed token, base64url again so it fits the cookie alphabet. */
export const orderAccessCookieValue = (secret: string, orderId: number, now = new Date()) =>
  Buffer.from(signLink(secret, 'order_access', { o: orderId }, ORDER_ACCESS_TTL_S, now)).toString('base64url');

/** The order id this request's order cookie opens, or null. */
export function orderAccessFromCookie(req: Request, env: DeployEnv, secret: string, now = new Date()): number | null {
  const raw = parseCookies(req.get('cookie')).get(cookieSpec('order', env).name);
  if (!raw || !/^[A-Za-z0-9_-]{1,2000}$/.test(raw)) return null;
  const payload = verifyLink(secret, 'order_access', Buffer.from(raw, 'base64url').toString('utf8'), now);
  return payload && typeof payload.o === 'number' ? payload.o : null;
}
