// Redis app cache for public catalogue data (architecture.md §6.1: navigation, settings, taxonomy; TTL 300 s, dropped on
// admin write). Invalidation bumps a generation number that is part of the key, so a reader that loaded old data while
// a write committed stores it under the old generation, where nobody looks again. Redis trouble never fails a request:
// the data is read from PostgreSQL and the problem reported.
import type { Redis } from 'ioredis';

export const APP_CACHE_TTL_S = 300;
export type CacheName = 'navigation' | 'publicSettings';

export interface AppCache {
  /** Cached value of `name`, or the result of `load` (then stored for `ttlS`). */
  get<T>(name: CacheName, load: () => Promise<T>, ttlS?: number): Promise<T>;
  /** Makes every cached copy of `name` unreachable (call after the write has committed). */
  invalidate(name: CacheName): Promise<void>;
}

export class RedisAppCache implements AppCache {
  constructor(private readonly redis: Redis, private readonly onError: (op: string, err: unknown) => void = () => {}) {}

  private gen(name: CacheName) { return `cache:gen:${name}`; }

  async get<T>(name: CacheName, load: () => Promise<T>, ttlS = APP_CACHE_TTL_S): Promise<T> {
    let key: string | null;
    try {
      key = `cache:${name}:${(await this.redis.get(this.gen(name))) ?? '0'}`;
      const hit = await this.redis.get(key);
      if (hit !== null) return JSON.parse(hit) as T;
    } catch (e) { this.onError('get', e); key = null; }
    const value = await load();
    if (key) {
      try { await this.redis.set(key, JSON.stringify(value), 'EX', ttlS); } catch (e) { this.onError('set', e); }
    }
    return value;
  }

  async invalidate(name: CacheName): Promise<void> {
    try { await this.redis.incr(this.gen(name)); } catch (e) { this.onError('invalidate', e); }
  }
}

/** No cache (tests, scripts): always loads. */
export const noAppCache: AppCache = { get: (_n, load) => load(), invalidate: async () => {} };
