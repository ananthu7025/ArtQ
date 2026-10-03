// The storefront talks only to the Express API (architecture.md §1.1), in two ways (task 3.2, §6.1):
// - publicGet: on the server, for prerendered pages (ISR 60 s). No cookies, and only allow-listed public paths, so a
//   personal response can never be baked into a page that is cached and served to everyone.
// - clientRequest: in the browser, with the customer's cookies (cart, session), never cached.
// If the API cannot be reached, layout data falls back to the default settings and an empty menu.
import { DEFAULT_PUBLIC_SETTINGS, isPublicCacheable, type Navigation, type PublicSettings } from '@artq/shared';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); }
}

type Fetch = (input: string, init?: RequestInit & { next?: { revalidate?: number } }) => Promise<Response>;

/** Browser call with the customer's cookies, never cached. Throws ApiError with the API's code; NETWORK when unreachable. */
export async function clientRequest<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown, fetchImpl: Fetch = fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${API_URL}${path}`, {
      method, credentials: 'include', cache: 'no-store',
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'We could not reach the store. Check your connection and try again.');
  }
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string; details?: unknown } } | null;
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'INTERNAL', data?.error?.message ?? 'Something went wrong. Please try again.', data?.error?.details);
  return data as T;
}

/** Browser POST (forms such as the newsletter). */
export const apiPost = <T>(path: string, body: unknown, fetchImpl: Fetch = fetch) => clientRequest<T>('POST', path, body, fetchImpl);

/** Server-side GET of an allow-listed public path for a prerendered page: cached 60 s, no cookies, cut off after `timeoutMs`. */
export async function publicGet<T>(path: string, fetchImpl: Fetch = fetch, timeoutMs = 3000): Promise<T> {
  if (!isPublicCacheable(path)) throw new Error(`publicGet(${path}): not a public, cacheable API path; personal data is fetched in the browser with clientRequest`);
  const res = await fetchImpl(`${API_URL}${path}`, { next: { revalidate: 60 }, signal: AbortSignal.timeout(timeoutMs), credentials: 'omit', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export type LayoutData = { navigation: Navigation; settings: PublicSettings; degraded: boolean };

/** Menu + public settings for every page. Each falls back on its own, so one failing endpoint does not empty the other. */
export async function loadLayout(fetchImpl: Fetch = fetch, timeoutMs = 3000): Promise<LayoutData> {
  const [nav, settings] = await Promise.allSettled([publicGet<Navigation>('/navigation', fetchImpl, timeoutMs), publicGet<PublicSettings>('/settings/public', fetchImpl, timeoutMs)]);
  return {
    navigation: nav.status === 'fulfilled' && Array.isArray(nav.value?.types) ? nav.value : { types: [] },
    settings: settings.status === 'fulfilled' && settings.value?.store ? settings.value : DEFAULT_PUBLIC_SETTINGS,
    degraded: nav.status === 'rejected' || settings.status === 'rejected',
  };
}
