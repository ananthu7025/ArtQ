// /v1/auth/* (api.md §3.4) and GET /v1/me. Every POST here can carry the refresh cookie, so all are Origin-guarded
// (architecture.md §5.5); the JSON-only rule is global.
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { PASSWORD_MAX } from '../lib/password.js';
import { originGuard } from '../middleware/originGuard.js';
import { validate } from '../middleware/validate.js';
import { clearCookie, cookieSpec, parseCookies, setCookie, type DeployEnv } from './cookies.js';
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

export type AuthRouterDeps = AuthDeps & { service: AuthService; env: DeployEnv; allowedOrigins: readonly string[]; refreshMaxAgeS: number };

const meta = (req: Request): ClientMeta => ({ ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null });

export function authRouter(d: AuthRouterDeps): Router {
  const r = Router();
  const spec = cookieSpec('refresh', d.env);
  const guard = originGuard(d.allowedOrigins);
  const readCookie = (req: Request) => parseCookies(req.get('cookie')).get(spec.name);
  const issue = (res: Response, i: Issued, status = 200) => {
    res.status(status).set('Cache-Control', 'no-store').setHeader('Set-Cookie', setCookie(spec, i.refreshToken, d.refreshMaxAgeS));
    res.json({ accessToken: i.accessToken, user: i.user });
  };

  r.post('/auth/signup', guard, validate({ body: schemas.signup }), async (req, res) => {
    res.status(201).set('Cache-Control', 'no-store').json(await d.service.signup(req.body));
  });
  r.post('/auth/signup/verify', guard, validate({ body: schemas.verify }), async (req, res) => {
    issue(res, await d.service.verifySignup(req.body, meta(req)));
  });
  r.post('/auth/login', guard, validate({ body: schemas.login }), async (req, res) => {
    issue(res, await d.service.login(req.body, meta(req)));
  });
  r.post('/auth/otp/request', guard, validate({ body: schemas.otpRequest }), async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await d.service.requestLoginOtp(req.body));
  });
  r.post('/auth/otp/verify', guard, validate({ body: schemas.otpVerify }), async (req, res) => {
    issue(res, await d.service.verifyLoginOtp(req.body, meta(req)));
  });
  r.post('/auth/refresh', guard, validate({ body: schemas.empty }), async (req, res) => {
    const out = await d.service.refresh(readCookie(req));
    res.set('Cache-Control', 'no-store');
    if (!out.ok) {
      res.setHeader('Set-Cookie', clearCookie(spec));
      throw new AppError(401, 'SESSION_INVALID', 'Your session has ended. Please log in again.');
    }
    if (out.refreshToken) res.setHeader('Set-Cookie', setCookie(spec, out.refreshToken, d.refreshMaxAgeS));
    res.json({ accessToken: out.accessToken, user: out.user });
  });
  r.post('/auth/logout', guard, validate({ body: schemas.empty }), async (req, res) => {
    await d.service.logout(readCookie(req));
    res.set('Cache-Control', 'no-store').setHeader('Set-Cookie', clearCookie(spec));
    res.json({ ok: true });
  });
  r.post('/auth/logout-all', guard, requireCustomer(d), validate({ body: schemas.empty }), async (req, res) => {
    await d.service.logoutAll(req.auth!.userId);
    res.set('Cache-Control', 'no-store').setHeader('Set-Cookie', clearCookie(spec));
    res.json({ ok: true });
  });
  r.post('/auth/password/forgot', guard, validate({ body: schemas.forgot }), async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await d.service.forgotPassword(req.body));
  });
  r.post('/auth/password/reset', guard, validate({ body: schemas.reset }), async (req, res) => {
    const out = await d.service.resetPassword(req.body);
    res.set('Cache-Control', 'no-store').setHeader('Set-Cookie', clearCookie(spec));
    res.json(out);
  });
  r.post('/auth/set-password', guard, validate({ body: schemas.reset }), async (req, res) => {
    issue(res, await d.service.setPassword(req.body, meta(req)));
  });
  r.get('/me', requireCustomer(d), async (req, res) => {
    res.set('Cache-Control', 'private, no-store').json({ user: await d.service.me(req.auth!.userId) });
  });
  return r;
}
