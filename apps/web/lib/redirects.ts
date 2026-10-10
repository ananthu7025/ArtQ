// The owner's redirects, looked up by proxy.ts (task 6.4). An address the shop does not serve itself (an old shop's
// URL, a retired page) is looked up through the API; a hit moves the visitor (301 or 302, keeping their query when the
// target has none). Lookups are remembered for a minute; if the API is slow or down the request simply goes on to the
// page (or the 404).
import { normalizeSeoPath, type SeoResolve } from '@artq/shared';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1').replace(/\/$/, '');
const TTL_MS = 60_000;
const MAX_ENTRIES = 2000;
const memo = new Map<string, { at: number; redirect: SeoResolve['redirect'] }>();

async function lookup(path: string, now: number, fetchImpl: typeof fetch): Promise<SeoResolve['redirect']> {
  const hit = memo.get(path);
  if (hit && now - hit.at < TTL_MS) return hit.redirect;
  try {
    const res = await fetchImpl(`${API_URL}/seo/resolve?path=${encodeURIComponent(path)}`, { signal: AbortSignal.timeout(1500), headers: { Accept: 'application/json' } });
    if (!res.ok) return null;   // not remembered: the next visit asks again
    const redirect = ((await res.json()) as SeoResolve).redirect ?? null;
    if (memo.size >= MAX_ENTRIES) memo.delete(memo.keys().next().value!);
    memo.set(path, { at: now, redirect });
    return redirect;
  } catch {
    return null;
  }
}

/** Where `url` should go instead, or null to serve it. Only addresses on this site are ever returned. */
export async function redirectFor(url: Pick<URL, 'origin' | 'pathname' | 'search'>, now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<{ url: URL; status: 301 | 302 } | null> {
  const r = await lookup(normalizeSeoPath(url.pathname), now, fetchImpl);
  if (!r || !r.to.startsWith('/') || r.to.startsWith('//') || r.to.startsWith('/\\')) return null;
  const target = new URL(r.to, url.origin);
  if (target.origin !== url.origin) return null;
  if (!target.search && url.search) target.search = url.search;
  return { url: target, status: r.status };
}

/** For tests: forget remembered lookups. */
export const clearRedirectMemo = () => memo.clear();
