// Rate limits (api.md §6). Fixed windows counted atomically in Redis (one Lua call per hit). If Redis is unavailable the
// request is allowed and the failure reported: availability wins, and the PostgreSQL-backed protections (account
// lockout, per-email OTP limits, OTP attempt caps) still apply.
import type { Request, RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { AppError } from '../lib/errors.js';

export type Limit = { limit: number; windowS: number };

/** api.md §6. Admin limits are applied by tasks 1.6/1.7, checkout/forms/search by their tasks. */
export const RATE_LIMITS = {
  default: { limit: 300, windowS: 60 },                  // per IP
  login: { limit: 10, windowS: 60 },                     // /auth/login, /admin/auth/login per IP
  emailSend: { limit: 20, windowS: 3600 },               // OTP request, signup, forgot password per IP (each sends an email)
  verify: { limit: 30, windowS: 60 },                    // code/link verification endpoints per IP
  refresh: { limit: 30, windowS: 60 },                   // per session
  mfa: { limit: 20, windowS: 60 },                       // /admin/auth/mfa/* per IP
  checkout: { limit: 20, windowS: 60 },                  // per cart
  publicForm: { limit: 5, windowS: 60 },                 // contact, custom work, newsletter, presign per IP
  searchSuggest: { limit: 60, windowS: 60 },             // per IP
  admin: { limit: 600, windowS: 60 },                    // per admin user
} as const satisfies Record<string, Limit>;

export type HitResult = { count: number; resetMs: number };

export interface RateLimiter {
  /** Counts one hit for `key` in a window of `windowS`; returns the count so far and ms until the window resets. */
  hit(key: string, windowS: number): Promise<HitResult>;
}

const LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {n, redis.call('PTTL', KEYS[1])}`;

export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: Redis) {}
  async hit(key: string, windowS: number): Promise<HitResult> {
    const [count, ttl] = (await this.redis.eval(LUA, 1, `rl:${key}`, String(windowS * 1000))) as [number, number];
    return { count, resetMs: ttl > 0 ? ttl : windowS * 1000 };
  }
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly m = new Map<string, { count: number; until: number }>();
  constructor(private readonly now = () => Date.now()) {}
  async hit(key: string, windowS: number): Promise<HitResult> {
    const t = this.now();
    const e = this.m.get(key);
    if (!e || e.until <= t) {
      this.m.set(key, { count: 1, until: t + windowS * 1000 });
      return { count: 1, resetMs: windowS * 1000 };
    }
    e.count++;
    return { count: e.count, resetMs: e.until - t };
  }
}

/**
 * Client address used for per-IP limits: IPv4-mapped IPv6 → IPv4; other IPv6 → its /64 (one customer network can
 * rotate through a whole /64). `req.ip` honours `trust proxy` (set in createApp).
 */
export function clientKey(req: Request): string {
  const ip = (req.ip ?? req.socket.remoteAddress ?? 'unknown').trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(':')) return ip;
  const [head] = ip.split('%') as [string];                       // zone id
  const parts = head.includes('::')
    ? (() => { const [a, b] = head.split('::') as [string, string]; const l = a ? a.split(':') : []; const r = b ? b.split(':') : []; return [...l, ...Array(8 - l.length - r.length).fill('0'), ...r]; })()
    : head.split(':');
  return `${parts.slice(0, 4).map((p) => (p || '0').toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export type RateLimitOptions = {
  limiter: RateLimiter;
  /** Bucket name, part of the key (e.g. "login"). */
  name: string;
  rule: Limit;
  /** Key within the bucket; defaults to the client IP. Returning null skips limiting for this request. */
  key?: (req: Request) => string | null | Promise<string | null>;
  onError?: (e: unknown) => void;
};

export function rateLimit(o: RateLimitOptions): RequestHandler {
  return async (req, res, next) => {
    const k = o.key ? await o.key(req) : clientKey(req);
    if (k === null) return next();
    let r: HitResult;
    try {
      r = await o.limiter.hit(`${o.name}:${k}`, o.rule.windowS);
    } catch (e) {
      o.onError?.(e);
      return next();                                               // fail open (see header comment)
    }
    const resetS = Math.max(1, Math.ceil(r.resetMs / 1000));
    res.setHeader('RateLimit-Limit', String(o.rule.limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, o.rule.limit - r.count)));
    res.setHeader('RateLimit-Reset', String(resetS));
    if (r.count > o.rule.limit) {
      res.setHeader('Retry-After', String(resetS));
      return next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Please try again shortly.', { retryAfterSeconds: resetS }));
    }
    next();
  };
}
