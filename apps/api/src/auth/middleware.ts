// Bearer authentication for storefront routes (architecture.md §5.4): JWT (audience, issuer, expiry) → session cache →
// aq_session_valid in PostgreSQL on a miss. Revoked sessions, blocked users and version changes fail on the next request.
import type { PrismaClient } from '@prisma/client';
import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';
import type { SessionCache } from './session-cache.js';
import { TokenInvalidError, verifyAccessToken, type JwtConfig } from './tokens.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { auth?: { userId: number; sessionId: string } }
  }
}

export type AuthDeps = { prisma: PrismaClient; cache: SessionCache; jwt: JwtConfig };

const invalid = () => new AppError(401, 'SESSION_INVALID', 'Your session has ended. Please log in again.');

export function requireCustomer(deps: AuthDeps): RequestHandler {
  return async (req, _res, next) => {
    const m = /^Bearer ([A-Za-z0-9._-]+)$/.exec(req.get('authorization') ?? '');
    if (!m) return next(new AppError(401, 'UNAUTHENTICATED', 'Authentication required'));
    let claims;
    try {
      claims = await verifyAccessToken(deps.jwt, m[1]!, 'storefront');
    } catch (e) {
      if (e instanceof TokenInvalidError) return next(new AppError(401, 'UNAUTHENTICATED', e.reason === 'expired' ? 'Access token expired' : 'Invalid access token'));
      return next(e);
    }
    const uid = Number(claims.sub);
    const hit = await deps.cache.get(claims.sid);
    if (hit.state === 'revoked') return next(invalid());
    let session = hit.state === 'valid' ? hit.session : null;
    if (!session) {
      const [row] = await deps.prisma.$queryRaw<{ user_id: number; audience: 'STOREFRONT' | 'ADMIN'; auth_version: number; valid: boolean }[]>`
        SELECT user_id, audience, auth_version, aq_session_valid(id) AS valid FROM sessions WHERE id = ${claims.sid}::uuid`;
      if (!row || !row.valid) return next(invalid());
      session = { uid: row.user_id, aud: row.audience, ver: row.auth_version };
      await deps.cache.fill(claims.sid, session);
    }
    if (session.aud !== 'STOREFRONT' || session.uid !== uid || session.ver !== claims.ver) return next(invalid());
    req.auth = { userId: uid, sessionId: claims.sid };
    next();
  };
}
