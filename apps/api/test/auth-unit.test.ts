import { describe, expect, it } from 'vitest';
import { clearCookie, cookieSpec, parseCookies, setCookie } from '../src/auth/cookies.js';
import { maskEmail } from '../src/auth/service.js';
import { MemorySessionCache, RedisSessionCache } from '../src/auth/session-cache.js';
import { otpCode, otpHash, randomToken, safeEqualHex, sha256, signAccessToken, signLink, TokenInvalidError, verifyAccessToken, verifyLink } from '../src/auth/tokens.js';

const attrs = (header: string) => header.split('; ').slice(1).filter((a) => !a.startsWith('Max-Age='));

describe('cookies (architecture.md §5.1)', () => {
  it.each([
    ['production', 'refresh', '__Secure-aq_rt', '/v1/auth', true],
    ['staging', 'refresh', '__Secure-aq_rt_stg', '/v1/auth', true],
    ['test', 'refresh', '__Secure-aq_rt_test', '/v1/auth', true],
    ['development', 'refresh', 'aq_rt_dev', '/v1/auth', false],
    ['production', 'adminRefresh', '__Secure-aq_admin_rt', '/v1/admin/auth', true],
    ['production', 'cart', '__Secure-aq_cart', '/v1', true],
    ['production', 'order', '__Secure-aq_order', '/v1/orders', true],
  ] as const)('%s %s → %s on %s', (env, kind, name, path, secure) => {
    expect(cookieSpec(kind, env)).toEqual({ name, path, secure });
  });

  it('set and clear carry identical attributes; clear has an empty value and Max-Age=0; never a Domain', () => {
    for (const env of ['production', 'development'] as const) {
      const spec = cookieSpec('refresh', env);
      const set = setCookie(spec, 'abc_DEF-123', 2_592_000);
      const clear = clearCookie(spec);
      expect(attrs(clear)).toEqual(attrs(set));
      expect(set).toContain('Max-Age=2592000');
      expect(clear.startsWith(`${spec.name}=;`)).toBe(true);
      expect(clear).toContain('Max-Age=0');
      expect(set.toLowerCase()).not.toContain('domain');
      expect(set).toContain('HttpOnly');
      expect(set).toContain('SameSite=Strict');
      expect(set.includes('Secure')).toBe(env === 'production');
    }
  });

  it('rejects unsafe values and bad max-age', () => {
    const spec = cookieSpec('refresh', 'production');
    expect(() => setCookie(spec, 'a;b', 1)).toThrow(/URL-safe/);
    expect(() => setCookie(spec, 'ok', -1)).toThrow(/maxAge/);
  });

  it('parses Cookie headers; first duplicate wins; junk ignored', () => {
    const m = parseCookies('a=1; __Secure-aq_rt=tok; a=2; junk; =x');
    expect(m.get('a')).toBe('1');
    expect(m.get('__Secure-aq_rt')).toBe('tok');
    expect(m.size).toBe(2);
    expect(parseCookies(undefined).size).toBe(0);
  });
});

describe('access tokens', () => {
  const cfg = { secret: new TextEncoder().encode('x'.repeat(40)), issuer: 'artq-test' };
  const claims = { sub: '7', sid: '00000000-0000-0000-0000-000000000001', aud: 'storefront' as const, ver: 3 };

  it('round-trips the claims', async () => {
    const t = await signAccessToken(cfg, claims, 600);
    expect(await verifyAccessToken(cfg, t, 'storefront')).toEqual(claims);
  });

  it.each([
    ['wrong audience', async () => verifyAccessToken(cfg, await signAccessToken(cfg, claims, 600), 'admin'), 'invalid'],
    ['wrong issuer', async () => verifyAccessToken({ ...cfg, issuer: 'artq-production' }, await signAccessToken(cfg, claims, 600), 'storefront'), 'invalid'],
    ['wrong secret', async () => verifyAccessToken({ ...cfg, secret: new TextEncoder().encode('y'.repeat(40)) }, await signAccessToken(cfg, claims, 600), 'storefront'), 'invalid'],
    ['expired', async () => verifyAccessToken(cfg, await signAccessToken(cfg, claims, 600, new Date(Date.now() - 3_600_000)), 'storefront'), 'expired'],
    ['tampered payload', async () => { const [h, , s] = (await signAccessToken(cfg, claims, 600)).split('.'); const p = Buffer.from(JSON.stringify({ ...claims, sub: '1', exp: 9e9 })).toString('base64url'); return verifyAccessToken(cfg, `${h}.${p}.${s}`, 'storefront'); }, 'invalid'],
    ['alg none', async () => { const h = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'); const p = Buffer.from(JSON.stringify({ ...claims, iss: 'artq-test', exp: 9e9, iat: 1 })).toString('base64url'); return verifyAccessToken(cfg, `${h}.${p}.`, 'storefront'); }, 'invalid'],
    ['non-numeric subject', async () => verifyAccessToken(cfg, await signAccessToken(cfg, { ...claims, sub: 'admin' }, 600), 'storefront'), 'invalid'],
    ['garbage', async () => verifyAccessToken(cfg, 'not.a.jwt', 'storefront'), 'invalid'],
  ])('rejects %s', async (_d, f, reason) => {
    const e = await f().then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(TokenInvalidError);
    expect((e as TokenInvalidError).reason).toBe(reason);
  });
});

describe('signed links', () => {
  const secret = 's'.repeat(40);
  it('round-trips and enforces signature, purpose and expiry', () => {
    const t = signLink(secret, 'set_password', { e: 'a@x.in' }, 60);
    expect(verifyLink(secret, 'set_password', t)).toMatchObject({ e: 'a@x.in', p: 'set_password' });
    expect(verifyLink(secret, 'other', t)).toBeNull();
    expect(verifyLink('t'.repeat(40), 'set_password', t)).toBeNull();
    expect(verifyLink(secret, 'set_password', signLink(secret, 'set_password', { e: 'a@x.in' }, 60, new Date(Date.now() - 120_000)))).toBeNull();
    const [body, mac] = t.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ e: 'evil@x.in', p: 'set_password', exp: 9e9 })).toString('base64url');
    expect(verifyLink(secret, 'set_password', `${forged}.${mac}`)).toBeNull();
    expect(verifyLink(secret, 'set_password', `${body}`)).toBeNull();
    expect(verifyLink(secret, 'set_password', `${body}.${mac}.x`)).toBeNull();
    expect(verifyLink(secret, 'set_password', `${body}.short`)).toBeNull();
  });
});

describe('random values and hashing', () => {
  it('OTP codes are 6 digits and vary; hashes depend on the pepper', () => {
    const codes = new Set(Array.from({ length: 200 }, otpCode));
    expect([...codes].every((c) => /^\d{6}$/.test(c))).toBe(true);
    expect(codes.size).toBeGreaterThan(190);
    expect(otpHash('123456', 'pepper-a')).not.toBe(otpHash('123456', 'pepper-b'));
    expect(otpHash('123456', 'p')).toBe(sha256('123456p'));
  });
  it('refresh tokens are 256-bit URL-safe and unique', () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
  });
  it('safeEqualHex', () => {
    expect(safeEqualHex(sha256('a'), sha256('a'))).toBe(true);
    expect(safeEqualHex(sha256('a'), sha256('b'))).toBe(false);
    expect(safeEqualHex('ab', 'abcd')).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
  });
  it('maskEmail', () => { expect(maskEmail('ananthu@gmail.com')).toBe('a***@gmail.com'); });
});

describe('session cache semantics', () => {
  it('a revocation tombstone wins over a later fill; entries expire', async () => {
    let now = 0;
    const c = new MemorySessionCache(60_000, () => now);
    const s = { uid: 1, aud: 'STOREFRONT' as const, ver: 1 };
    expect(await c.get('a')).toEqual({ state: 'miss' });
    await c.fill('a', s);
    expect(await c.get('a')).toEqual({ state: 'valid', session: s });
    await c.revoke(['a']);
    await c.fill('a', s);                                  // a request that validated before the revoke
    expect(await c.get('a')).toEqual({ state: 'revoked' });
    now += 60_001;
    expect(await c.get('a')).toEqual({ state: 'miss' });
  });

  it('Redis failures degrade to a miss (PostgreSQL decides) and are reported', async () => {
    const errors: string[] = [];
    const broken = { get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); }, multi: () => ({ set() { return this; }, exec: async () => { throw new Error('down'); } }) };
    const c = new RedisSessionCache(broken as never, 60, (op) => errors.push(op));
    expect(await c.get('a')).toEqual({ state: 'miss' });
    await c.fill('a', { uid: 1, aud: 'STOREFRONT', ver: 1 });
    await c.revoke(['a']);
    expect(errors).toEqual(['get', 'fill', 'revoke']);
  });
});
