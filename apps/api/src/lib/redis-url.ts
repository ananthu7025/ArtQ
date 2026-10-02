// BullMQ needs connection options rather than a URL. Parse every part of REDIS_URL so none is silently dropped:
// username/password, database index (`/5`) and TLS (`rediss://`, required by most managed Redis providers).
export type RedisConnectionOptions = {
  host: string; port: number; db: number; username?: string; password?: string; tls?: Record<string, never>; maxRetriesPerRequest: null;
};

export function redisConnection(url: string): RedisConnectionOptions {
  const u = new URL(url);
  if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') throw new TypeError(`not a redis URL: ${u.protocol}`);
  const db = u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : 0;
  if (!Number.isInteger(db) || db < 0 || db > 15) throw new TypeError(`invalid redis database index "${u.pathname.slice(1)}"`);
  return {
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: Number(u.port || 6379),
    db,
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}
