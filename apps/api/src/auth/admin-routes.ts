// /v1/admin/auth/* and GET /v1/admin/me (api.md §4.1). Email + password; MFA is deferred (owner decision 2026-10-02),
// so step-up for sensitive actions is a password re-check. Only ADMIN_ORIGINS may call /v1/admin/* (createApp).
import { permissionsFor } from '@artq/shared';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { PASSWORD_MAX } from '../lib/password.js';
import { clientKey, RATE_LIMITS, rateLimit, type Limit, type RateLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { clearCookie, cookieSpec, parseCookies, setCookie, type DeployEnv } from './cookies.js';
import { requireAdmin, type AuthDeps } from './middleware.js';
import type { AuthService, ClientMeta, Issued } from './service.js';
import { sha256 } from './tokens.js';

const schemas = {
  login: z.strictObject({ email: z.email().max(160), password: z.string().min(1).max(PASSWORD_MAX) }),
  stepUp: z.strictObject({ password: z.string().min(1).max(PASSWORD_MAX) }),
  empty: z.strictObject({}),
};

export type AdminAuthRouterDeps = AuthDeps & { service: AuthService; env: DeployEnv; limiter: RateLimiter; onRateLimitError?: (e: unknown) => void };

/** 600/min per admin user (api.md §6); use after requireAdmin on every admin router. */
export function adminUserLimit(limiter: RateLimiter, onError?: (e: unknown) => void): RequestHandler {
  return rateLimit({ limiter, name: 'admin-user', rule: RATE_LIMITS.admin, key: async (req) => (req.auth ? `u:${req.auth.userId}` : null), ...(onError ? { onError } : {}) });
}

const meta = (req: Request): ClientMeta => ({ ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null });

export function adminAuthRouter(d: AdminAuthRouterDeps): Router {
  const r = Router();
  const spec = cookieSpec('adminRefresh', d.env);
  const maxAge = d.service.refreshCookieMaxAge('ADMIN');
  const readCookie = (req: Request) => parseCookies(req.get('cookie')).get(spec.name);
  const limit = (name: string, rule: Limit, key?: (req: Request) => Promise<string | null>) =>
    rateLimit({ limiter: d.limiter, name, rule, ...(key ? { key } : {}), ...(d.onRateLimitError ? { onError: d.onRateLimitError } : {}) });
  const auth = requireAdmin(d);
  const perUser = adminUserLimit(d.limiter, d.onRateLimitError);
  const issue = (res: Response, i: Issued) => {
    res.set('Cache-Control', 'no-store').setHeader('Set-Cookie', setCookie(spec, i.refreshToken, maxAge));
    res.json({ accessToken: i.accessToken, user: i.user });
  };

  r.post('/admin/auth/login', limit('admin-login', RATE_LIMITS.login), validate({ body: schemas.login }), async (req, res) => {
    issue(res, await d.service.adminLogin(req.body, meta(req)));
  });
  r.post('/admin/auth/refresh', limit('admin-refresh', RATE_LIMITS.refresh, async (req) => {
    const t = readCookie(req);
    const row = t ? await d.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(t) }, select: { sessionId: true } }) : null;
    return row ? `s:${row.sessionId}` : `ip:${clientKey(req)}`;
  }), validate({ body: schemas.empty }), async (req, res) => {
    const out = await d.service.refresh(readCookie(req), 'ADMIN');
    res.set('Cache-Control', 'no-store');
    if (!out.ok) {
      res.setHeader('Set-Cookie', clearCookie(spec));
      throw new AppError(401, 'SESSION_INVALID', 'Your session has ended. Please log in again.');
    }
    if (out.refreshToken) res.setHeader('Set-Cookie', setCookie(spec, out.refreshToken, maxAge));
    res.json({ accessToken: out.accessToken, user: out.user });
  });
  r.post('/admin/auth/logout', validate({ body: schemas.empty }), async (req, res) => {
    await d.service.logout(readCookie(req), 'ADMIN');
    res.set('Cache-Control', 'no-store').setHeader('Set-Cookie', clearCookie(spec));
    res.json({ ok: true });
  });
  r.post('/admin/auth/logout-all', auth, perUser, validate({ body: schemas.empty }), async (req, res) => {
    await d.service.logoutAll(req.auth!.userId);
    res.set('Cache-Control', 'no-store').setHeader('Set-Cookie', clearCookie(spec));
    res.json({ ok: true });
  });
  r.post('/admin/auth/step-up', auth, limit('admin-step-up', RATE_LIMITS.mfa), validate({ body: schemas.stepUp }), async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await d.service.adminStepUp(req.auth!.sessionId, req.auth!.userId, req.body.password));
  });
  r.get('/admin/me', auth, perUser, async (req, res) => {
    // permissions[] only drives what the SPA shows; every endpoint enforces its own permission server-side.
    res.set('Cache-Control', 'private, no-store').json({ user: await d.service.me(req.auth!.userId), permissions: permissionsFor(req.auth!.role) });
  });
  return r;
}
