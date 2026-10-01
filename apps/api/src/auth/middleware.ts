// Bearer authentication (architecture.md §5.4): JWT (audience, issuer, expiry) → session cache → aq_session_valid in
// PostgreSQL on a miss. Revoked sessions, blocked users, role and version changes fail on the next request.
import type { PrismaClient, UserRole } from '@prisma/client';
import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';
import type { SessionCache } from './session-cache.js';
import { TokenInvalidError, verifyAccessToken, type Audience, type JwtConfig } from './tokens.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { auth?: { userId: number; sessionId: string; role: UserRole } }
  }
}

export type AuthDeps = { prisma: PrismaClient; cache: SessionCache; jwt: JwtConfig };

const invalid = () => new AppError(401, 'SESSION_INVALID', 'Your session has ended. Please log in again.');

function requireSession(deps: AuthDeps, audience: Audience): RequestHandler {
  const sessionAud = audience === 'admin' ? 'ADMIN' : 'STOREFRONT';
  return async (req, _res, next) => {
    const m = /^Bearer ([A-Za-z0-9._-]+)$/.exec(req.get('authorization') ?? '');
    if (!m) return next(new AppError(401, 'UNAUTHENTICATED', 'Authentication required'));
    let claims;
    try {
      claims = await verifyAccessToken(deps.jwt, m[1]!, audience);
    } catch (e) {
      if (e instanceof TokenInvalidError) return next(new AppError(401, 'UNAUTHENTICATED', e.reason === 'expired' ? 'Access token expired' : 'Invalid access token'));
      return next(e);
    }
    const uid = Number(claims.sub);
    const hit = await deps.cache.get(claims.sid);
    if (hit.state === 'revoked') return next(invalid());
    let session = hit.state === 'valid' ? hit.session : null;
    if (!session || session.role === undefined) {
      const [row] = await deps.prisma.$queryRaw<{ user_id: number; audience: 'STOREFRONT' | 'ADMIN'; auth_version: number; role: UserRole; valid: boolean }[]>`
        SELECT s.user_id, s.audience, s.auth_version, u.role, aq_session_valid(s.id) AS valid
          FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ${claims.sid}::uuid`;
      if (!row || !row.valid) return next(invalid());
      session = { uid: row.user_id, aud: row.audience, ver: row.auth_version, role: row.role };
      await deps.cache.fill(claims.sid, session);
    }
    if (session.aud !== sessionAud || session.uid !== uid || session.ver !== claims.ver) return next(invalid());
    req.auth = { userId: uid, sessionId: claims.sid, role: session.role as UserRole };
    next();
  };
}

/** Storefront Bearer token (audience storefront). */
export const requireCustomer = (deps: AuthDeps): RequestHandler => requireSession(deps, 'storefront');

/** Admin Bearer token (audience admin). The database already refuses admin sessions of CUSTOMER-role users. */
export const requireAdmin = (deps: AuthDeps): RequestHandler => requireSession(deps, 'admin');

/**
 * For refunds, payment/settings changes, staff role changes and customer-data exports (architecture.md §5.8): the
 * admin must have re-entered the password within the step-up window, else 401 STEP_UP_REQUIRED. Use after requireAdmin.
 */
export function requireStepUp(hasRecentStepUp: (sessionId: string) => Promise<boolean>): RequestHandler {
  return async (req, _res, next) => {
    if (!req.auth) return next(new AppError(401, 'UNAUTHENTICATED', 'Authentication required'));
    if (!(await hasRecentStepUp(req.auth.sessionId))) {
      return next(new AppError(401, 'STEP_UP_REQUIRED', 'Please re-enter your password to continue'));
    }
    next();
  };
}
