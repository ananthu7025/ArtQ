// Cookies (architecture.md §5.1). One builder produces both the Set-Cookie and the clearing header, so the attributes
// of a clear always match the set: same name, Path, Secure, HttpOnly, SameSite and no Domain (host-only).

export type DeployEnv = 'development' | 'test' | 'staging' | 'production';
export type CookieKind = 'refresh' | 'adminRefresh' | 'cart' | 'order';

const BASE: Record<CookieKind, { name: string; path: string }> = {
  refresh: { name: 'aq_rt', path: '/v1/auth' },
  adminRefresh: { name: 'aq_admin_rt', path: '/v1/admin/auth' },
  cart: { name: 'aq_cart', path: '/v1' },
  order: { name: 'aq_order', path: '/v1/orders' },
};

export type CookieSpec = { name: string; path: string; secure: boolean };

/**
 * production `__Secure-aq_rt`; staging `__Secure-aq_rt_stg`; test `__Secure-aq_rt_test`;
 * development (HTTP on localhost only) `aq_rt_dev` without Secure.
 */
export function cookieSpec(kind: CookieKind, env: DeployEnv): CookieSpec {
  const { name, path } = BASE[kind];
  if (env === 'development') return { name: `${name}_dev`, path, secure: false };
  const suffix = env === 'production' ? '' : env === 'staging' ? '_stg' : '_test';
  return { name: `__Secure-${name}${suffix}`, path, secure: true };
}

function serialize(spec: CookieSpec, value: string, maxAgeSeconds: number): string {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new RangeError('cookie value must be URL-safe base64');
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0) throw new RangeError('maxAge must be a non-negative integer');
  return [`${spec.name}=${value}`, `Path=${spec.path}`, `Max-Age=${maxAgeSeconds}`, 'HttpOnly', ...(spec.secure ? ['Secure'] : []), 'SameSite=Strict'].join('; ');
}

export const setCookie = (spec: CookieSpec, value: string, maxAgeSeconds: number) => serialize(spec, value, maxAgeSeconds);
export const clearCookie = (spec: CookieSpec) => serialize(spec, '', 0);

/** Parses a Cookie request header. Later duplicates do not override the first (browsers send the most specific first). */
export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !out.has(k)) out.set(k, part.slice(i + 1).trim());
  }
  return out;
}
