// /v1/auth/* (api.md §3.4) and GET /v1/me. Origin policy and the JSON-only rule are app-wide (createApp); the
// per-endpoint rate limits of api.md §6 are applied here.
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { PASSWORD_MAX } from '../lib/password.js';
import { clientKey, RATE_LIMITS, rateLimit, type Limit, type RateLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { clearCookie, cookieSpec, parseCookies, setCookie, type DeployEnv } from './cookies.js';
import { sha256 } from './tokens.js';
import { requireCustomer, type AuthDeps } from './middleware.js';
import type { AuthService, ClientMeta, Issued } from './service.js';

export const CUSTOMER_PASSWORD_MIN = 8;

const email = z.email().max(160);
const password = z.string().min(CUSTOMER_PASSWORD_MIN).max(PASSWORD_MAX);
const code = z.string().regex(/^\d{6}$/, 'must be 6 digits');
const token = z.string().min(10).max(1000);

export const schemas = {
  signup: z.strictObject({
    name: z.string().trim().min(1).max(120), email, password, marketingOptIn: z.boolean().default(false),
    phone: z.string().regex(/^\+?\d{10,14}$/, 'must be a phone number').optional(),
  }),
  verify: z.strictObject({ email, code }),
  login: z.strictObject({ email, password: z.string().min(1).max(PASSWORD_MAX) }),
  otpRequest: z.strictObject({ email, purpose: z.literal('LOGIN') }),
  otpVerify: z.strictObject({ email, purpose: z.literal('LOGIN'), code }),
  empty: z.strictObject({}),
  forgot: z.strictObject({ email }),
  reset: z.strictObject({ token, password }),
};

export type AuthRouterDeps = AuthDeps & { service: AuthService; env: DeployEnv; refreshMaxAgeS: number; limiter: RateLimiter; onRateLimitError?: (e: unknown) => void };

const meta = (req: Request): ClientMeta => ({ ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null });

export function authRouter(d: AuthRouterDeps): Router {
  const r = Router();
  const spec = cookieSpec('refresh', d.env);
  const readCookie = (req: Request) => parseCookies(req.get('cookie')).get(spec.name);
  const limit = (name: string, rule: Limit, key?: (req: Request) => Promise<string | null>) =>
    rateLimit({ limiter: d.limiter, name, rule, ...(key ? { key } : {}), ...(d.onRateLimitError ? { onError: d.onRateLimitError } : {}) });
  const perIp = {
    login: limit('auth-login', RATE_LIMITS.login),
    emailSend: limit('auth-email', RATE_LIMITS.emailSend),
    verify: limit('auth-verify', RATE_LIMITS.verify),
  };
  // 30/min per session: the session is found from the cookie's hash; unknown or missing cookies count against the IP.
  const perSession = limit('auth-refresh', RATE_LIMITS.refresh, async (req) => {
    const t = readCookie(req);
    const row = t ? await d.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(t) }, select: { sessionId: true } }) : null;
    return row ? `s:${row.sessionId}` : `ip:${clientKey(req)}`;
  });
  const issue = (res: Response, i: Issued, status = 200) => {
    res.status(status).set('Cache-Control', 'no-store').setHeader('Set-Cookie', setCookie(spec, i.refreshToken, d.refreshMaxAgeS));
    res.json({ accessToken: i.accessToken, user: i.user });
  };

  r.post('/auth/signup', perIp.emailSend, validate({ body: schemas.signup }), async (req, res) => {
    res.status(201).set('Cache-Control', 'no-store').json(await d.service.signup(req.body));
  });
  r.post('/auth/signup/verify', perIp.verify, validate({ body: schemas.verify }), async (req, res) => {
    issue(res, await d.service.verifySignup(req.body, meta(req)));
  });
  r.post('/auth/login', perIp.login, validate({ body: schemas.login }), async (req, res) => {
    issue(res, await d.service.login(req.body, meta(req)));
  });
  r.post('/auth/otp/request', perIp.emailSend, validate({ body: schemas.otpRequest }), async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await d.service.requestLoginOtp(req.body));
  });
  r.post('/auth/otp/verify', perIp.verify, validate({ body: schemas.otpVerify }), async (req, res) => {
    issue(res, await d.service.verifyLoginOtp(req.body, meta(req)));
  });
  r.post('/auth/refresh', perSession, validate({ body: schemas.empty }), async (req, res) => {
    const out = await d.service.refresh(readCookie(req));
    res.set('Cache-Control', 'no-store');
    if (!out.ok) {
      res.setHeader('Set-Cookie', clearCookie(spec));
      throw new AppError(401, 'SESSION_INVALID', 'Your session has ended. Please log in again.');
    }
    if (out.refreshToken) res.setHeader('Set-Cookie', setCookie(spec, out.refreshToken, d.refreshMaxAgeS));
    res.json({ accessToken: out.accessToken, user: out.user });
  });
  r.post('/auth/logout', validate({ body: schemas.empty }), async (req, res) => {
    await d.service.logout(readCookie(req));
    res.set('Cache-Control', 'no-store').setHeader('Set-Cookie', clearCookie(spec));
    res.json({ ok: true });
  });
  r.post('/auth/logout-all', requireCustomer(d), validate({ body: schemas.empty }), async (req, res) => {
    await d.service.logoutAll(req.auth!.userId);
    res.set('Cache-Control', 'no-store').setHeader('Set-Cookie', clearCookie(spec));
    res.json({ ok: true });
  });
  r.post('/auth/password/forgot', perIp.emailSend, validate({ body: schemas.forgot }), async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await d.service.forgotPassword(req.body));
  });
  r.post('/auth/password/reset', perIp.verify, validate({ body: schemas.reset }), async (req, res) => {
    const out = await d.service.resetPassword(req.body);
    res.set('Cache-Control', 'no-store').setHeader('Set-Cookie', clearCookie(spec));
    res.json(out);
  });
  r.post('/auth/set-password', perIp.verify, validate({ body: schemas.reset }), async (req, res) => {
    issue(res, await d.service.setPassword(req.body, meta(req)));
  });
  r.get('/me', requireCustomer(d), async (req, res) => {
    res.set('Cache-Control', 'private, no-store').json({ user: await d.service.me(req.auth!.userId) });
  });
  return r;
}
