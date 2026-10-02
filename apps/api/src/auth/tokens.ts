// Token primitives: random opaque tokens (stored only as SHA-256), access JWTs (HS256 via jose), OTP codes and
// HMAC-signed link tokens (set-password links for guest checkouts).
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { errors, jwtVerify, SignJWT } from 'jose';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** 256-bit URL-safe random token. */
export const randomToken = () => randomBytes(32).toString('base64url');

/** 6-digit numeric code, uniformly random. */
export const otpCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

/** OTP hash = sha256(code + pepper) (database.md §3.1). */
export const otpHash = (code: string, pepper: string) => sha256(code + pepper);

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export type Audience = 'storefront' | 'admin';
export type AccessClaims = { sub: string; sid: string; aud: Audience; ver: number; mfa_at?: number };
export type JwtConfig = { secret: Uint8Array; issuer: string };

export function signAccessToken(cfg: JwtConfig, c: AccessClaims, ttlSeconds: number, now = new Date()): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ sid: c.sid, ver: c.ver, ...(c.mfa_at === undefined ? {} : { mfa_at: c.mfa_at }) })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(c.sub).setAudience(c.aud).setIssuer(cfg.issuer).setIssuedAt(iat).setExpirationTime(iat + ttlSeconds)
    .sign(cfg.secret);
}

export class TokenInvalidError extends Error {
  constructor(readonly reason: 'expired' | 'invalid') { super(`access token ${reason}`); this.name = 'TokenInvalidError'; }
}

/** Verifies signature (HS256 only), issuer, audience and expiry. */
export async function verifyAccessToken(cfg: JwtConfig, token: string, audience: Audience, now = new Date()): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, cfg.secret, { algorithms: ['HS256'], issuer: cfg.issuer, audience, currentDate: now, requiredClaims: ['sub', 'exp', 'iat'] });
    if (typeof payload.sid !== 'string' || typeof payload.ver !== 'number' || !/^\d+$/.test(payload.sub!)) throw new TokenInvalidError('invalid');
    return { sub: payload.sub!, sid: payload.sid, aud: audience, ver: payload.ver, ...(typeof payload.mfa_at === 'number' ? { mfa_at: payload.mfa_at } : {}) };
  } catch (e) {
    if (e instanceof TokenInvalidError) throw e;
    throw new TokenInvalidError(e instanceof errors.JWTExpired ? 'expired' : 'invalid');
  }
}

/** `<base64url(json)>.<base64url(hmac-sha256)>` with an `exp` (seconds) and a `purpose`. */
export function signLink(secret: string, purpose: string, data: Record<string, string | number>, ttlSeconds: number, now = new Date()): string {
  const body = Buffer.from(JSON.stringify({ ...data, p: purpose, exp: Math.floor(now.getTime() / 1000) + ttlSeconds })).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

/** Returns the payload, or null when the signature, purpose or expiry is wrong. */
export function verifyLink(secret: string, purpose: string, token: string, now = new Date()): Record<string, string | number> | null {
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let data: unknown;
  try { data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, string | number>;
  if (d.p !== purpose || typeof d.exp !== 'number' || d.exp <= Math.floor(now.getTime() / 1000)) return null;
  return d;
}
