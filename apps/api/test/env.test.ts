import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnv } from '../src/config/env.js';

const base = {
  NODE_ENV: 'development', DATABASE_URL: 'postgresql://artq:artq@localhost:5432/artq',
  REDIS_URL: 'redis://localhost:6379', STOREFRONT_ORIGINS: 'http://localhost:3000, http://127.0.0.1:3000', ADMIN_ORIGINS: 'http://localhost:5173',
  AUTH_JWT_SECRET: 'dev-insecure-jwt-secret-0123456789abcdef', AUTH_OTP_PEPPER: 'dev-insecure-otp-pepper-0123',
  AUTH_LINK_SECRET: 'dev-insecure-link-secret-0123456789abcdef', WEB_URL: 'http://localhost:3000',
};
const prodSecrets = { AUTH_JWT_SECRET: 'p'.repeat(40), AUTH_OTP_PEPPER: 'q'.repeat(20), AUTH_LINK_SECRET: 'r'.repeat(40), WEB_URL: 'https://artq.in' };
const fails = (over: Record<string, string | undefined>) => {
  try { loadEnv({ ...base, ...over }); } catch (e) { expect(e).toBeInstanceOf(ConfigError); return (e as ConfigError).message; }
  throw new Error('expected ConfigError');
};

describe('loadEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(4000);
    expect(env.APP_VERSION).toBe('dev');
    expect(env.STOREFRONT_ORIGINS).toEqual(['http://localhost:3000', 'http://127.0.0.1:3000']);
    expect(env.ADMIN_ORIGINS).toEqual(['http://localhost:5173']);
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
    expect(fails({ STOREFRONT_ORIGINS: 'http://localhost:3000/path' })).toContain('STOREFRONT_ORIGINS');
    expect(fails({ ADMIN_ORIGINS: '*' })).toContain('ADMIN_ORIGINS');
    expect(fails({ STOREFRONT_ORIGINS: '' })).toContain('STOREFRONT_ORIGINS');
  });
  it('rejects plain-http origins in production', () => {
    expect(fails({ ...prodSecrets, NODE_ENV: 'production', STOREFRONT_ORIGINS: 'http://artq.in', ADMIN_ORIGINS: 'https://admin.artq.in' })).toContain('STOREFRONT_ORIGINS: production origins must use https://');
    expect(fails({ ...prodSecrets, NODE_ENV: 'production', STOREFRONT_ORIGINS: 'https://artq.in', ADMIN_ORIGINS: 'http://admin.artq.in' })).toContain('ADMIN_ORIGINS: production origins must use https://');
    expect(loadEnv({ ...base, ...prodSecrets, NODE_ENV: 'production', STOREFRONT_ORIGINS: 'https://artq.in,https://www.artq.in', ADMIN_ORIGINS: 'https://admin.artq.in' }).STOREFRONT_ORIGINS).toHaveLength(2);
  });

  describe('auth settings', () => {
    it('defaults the issuer per environment', () => {
      expect(loadEnv(base).AUTH_JWT_ISSUER).toBe('artq-development');
      expect(loadEnv({ ...base, AUTH_JWT_ISSUER: 'custom' }).AUTH_JWT_ISSUER).toBe('custom');
    });
    it.each(['AUTH_JWT_SECRET', 'AUTH_OTP_PEPPER', 'AUTH_LINK_SECRET', 'WEB_URL'])('requires %s', (k) => {
      expect(fails({ [k]: undefined })).toContain(k);
    });
    it('rejects short secrets and a non-origin WEB_URL', () => {
      expect(fails({ AUTH_JWT_SECRET: 'short' })).toContain('AUTH_JWT_SECRET');
      expect(fails({ AUTH_OTP_PEPPER: 'short' })).toContain('AUTH_OTP_PEPPER');
      expect(fails({ WEB_URL: 'http://localhost:3000/path' })).toContain('WEB_URL');
    });
    it('rejects the same secret for JWTs and links', () => {
      expect(fails({ AUTH_LINK_SECRET: base.AUTH_JWT_SECRET })).toContain('must differ');
    });
    it.each(['staging', 'production'])('refuses development placeholders and http WEB_URL in %s', (NODE_ENV) => {
      const msg = fails({ NODE_ENV, STOREFRONT_ORIGINS: 'https://artq.in', ADMIN_ORIGINS: 'https://admin.artq.in', WEB_URL: 'http://artq.in' });
      for (const k of ['AUTH_JWT_SECRET', 'AUTH_OTP_PEPPER', 'AUTH_LINK_SECRET', 'WEB_URL']) expect(msg).toContain(k);
      expect(loadEnv({ ...base, ...prodSecrets, NODE_ENV, STOREFRONT_ORIGINS: 'https://artq.in', ADMIN_ORIGINS: 'https://admin.artq.in' }).AUTH_JWT_ISSUER).toBe(`artq-${NODE_ENV}`);
    });
  });

  it('requires both origin lists and keeps them disjoint', () => {
    expect(fails({ STOREFRONT_ORIGINS: undefined })).toContain('STOREFRONT_ORIGINS');
    expect(fails({ ADMIN_ORIGINS: undefined })).toContain('ADMIN_ORIGINS');
    expect(fails({ ADMIN_ORIGINS: 'http://localhost:5173,http://localhost:3000' })).toContain('must not overlap');
  });
});
