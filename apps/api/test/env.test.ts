import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnv } from '../src/config/env.js';

const base = {
  NODE_ENV: 'development', DATABASE_URL: 'postgresql://artq:artq@localhost:5432/artq',
  REDIS_URL: 'redis://localhost:6379', CORS_ORIGINS: 'http://localhost:3000, http://localhost:5173',
};
const fails = (over: Record<string, string | undefined>) => {
  try { loadEnv({ ...base, ...over }); } catch (e) { expect(e).toBeInstanceOf(ConfigError); return (e as ConfigError).message; }
  throw new Error('expected ConfigError');
};

describe('loadEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(4000);
    expect(env.APP_VERSION).toBe('dev');
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000', 'http://localhost:5173']);
  });
  it('coerces PORT', () => { expect(loadEnv({ ...base, PORT: '8080' }).PORT).toBe(8080); });
  it('names every missing variable', () => {
    const msg = fails({ DATABASE_URL: undefined, REDIS_URL: undefined });
    expect(msg).toContain('DATABASE_URL'); expect(msg).toContain('REDIS_URL');
  });
  it('rejects an unknown NODE_ENV', () => { expect(fails({ NODE_ENV: 'prod' })).toContain('NODE_ENV'); });
  it('rejects a non-postgres database URL', () => { expect(fails({ DATABASE_URL: 'mysql://x@localhost/db' })).toContain('postgresql'); });
  it('rejects a non-redis URL', () => { expect(fails({ REDIS_URL: 'http://localhost:6379' })).toContain('redis'); });
  it('rejects an out-of-range port', () => { expect(fails({ PORT: '70000' })).toContain('PORT'); });
  it('rejects CORS entries that are not bare origins', () => {
    expect(fails({ CORS_ORIGINS: 'http://localhost:3000/path' })).toContain('CORS_ORIGINS');
    expect(fails({ CORS_ORIGINS: '*' })).toContain('CORS_ORIGINS');
    expect(fails({ CORS_ORIGINS: '' })).toContain('CORS_ORIGINS');
  });
  it('rejects plain-http origins in production', () => {
    expect(fails({ NODE_ENV: 'production', CORS_ORIGINS: 'http://artq.in' })).toContain('https');
    expect(loadEnv({ ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://artq.in,https://admin.artq.in' }).CORS_ORIGINS).toHaveLength(2);
  });
});
