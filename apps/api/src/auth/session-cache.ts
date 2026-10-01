// Session validity cache (architecture.md §5.4): key `session:<sid>`, TTL 60 s, PostgreSQL (aq_session_valid) is the truth.
// Revocation writes a short-lived tombstone instead of deleting, and fills use SET NX: a request that validated just before
// a revoke can therefore never re-populate the cache with a stale "valid" entry after it.
import type { Redis } from 'ioredis';

/** `role` is safe to cache: a role change bumps admin_auth_version and tombstones the user's admin sessions. */
export type CachedSession = { uid: number; aud: 'STOREFRONT' | 'ADMIN'; ver: number; role?: string };
export type CacheLookup = { state: 'valid'; session: CachedSession } | { state: 'revoked' } | { state: 'miss' };

export interface SessionCache {
  get(sid: string): Promise<CacheLookup>;
  fill(sid: string, s: CachedSession): Promise<void>;
  revoke(sids: readonly string[]): Promise<void>;
}

const key = (sid: string) => `session:${sid}`;
const TOMBSTONE = 'revoked';

export class RedisSessionCache implements SessionCache {
  constructor(private readonly redis: Redis, private readonly ttlSeconds = 60, private readonly onError: (op: string, e: unknown) => void = () => {}) {}

  async get(sid: string): Promise<CacheLookup> {
    try {
      const v = await this.redis.get(key(sid));
      if (v === null) return { state: 'miss' };
      if (v === TOMBSTONE) return { state: 'revoked' };
      return { state: 'valid', session: JSON.parse(v) as CachedSession };
    } catch (e) {
      this.onError('get', e);
      return { state: 'miss' };                       // Redis down ⇒ fall back to PostgreSQL
    }
  }

  async fill(sid: string, s: CachedSession): Promise<void> {
    try { await this.redis.set(key(sid), JSON.stringify(s), 'EX', this.ttlSeconds, 'NX'); } catch (e) { this.onError('fill', e); }
  }

  /** Called after the revoking transaction commits. */
  async revoke(sids: readonly string[]): Promise<void> {
    if (sids.length === 0) return;
    try {
      const m = this.redis.multi();
      for (const sid of sids) m.set(key(sid), TOMBSTONE, 'EX', this.ttlSeconds);
      await m.exec();
    } catch (e) { this.onError('revoke', e); }
  }
}

/** In-process cache with the same semantics (unit tests, or a deployment without Redis). */
export class MemorySessionCache implements SessionCache {
  private readonly map = new Map<string, { v: CachedSession | typeof TOMBSTONE; until: number }>();
  constructor(private readonly ttlMs = 60_000, private readonly now = () => Date.now()) {}
  async get(sid: string): Promise<CacheLookup> {
    const e = this.map.get(sid);
    if (!e || e.until <= this.now()) return { state: 'miss' };
    return e.v === TOMBSTONE ? { state: 'revoked' } : { state: 'valid', session: e.v };
  }
  async fill(sid: string, s: CachedSession): Promise<void> {
    const e = this.map.get(sid);
    if (!e || e.until <= this.now()) this.map.set(sid, { v: s, until: this.now() + this.ttlMs });
  }
  async revoke(sids: readonly string[]): Promise<void> {
    for (const sid of sids) this.map.set(sid, { v: TOMBSTONE, until: this.now() + this.ttlMs });
  }
}
