// The storefront talks only to the Express API (architecture.md §1.1). Public layout data is fetched on the server with
// ISR (60 s); if the API cannot be reached the page still renders, with the default settings and an empty menu.
import { DEFAULT_PUBLIC_SETTINGS, type Navigation, type PublicSettings } from '@artq/shared';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); }
}

type Fetch = (input: string, init?: RequestInit & { next?: { revalidate?: number } }) => Promise<Response>;

/** Browser POST to a public endpoint (no cookies needed). Throws ApiError with the API's code; NETWORK when unreachable. */
export async function apiPost<T>(path: string, body: unknown, fetchImpl: Fetch = fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${API_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit' });
  } catch {
    throw new ApiError(0, 'NETWORK', 'We could not reach the store. Check your connection and try again.');
  }
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string; details?: unknown } } | null;
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'INTERNAL', data?.error?.message ?? 'Something went wrong. Please try again.', data?.error?.details);
  return data as T;
}

export type LayoutData = { navigation: Navigation; settings: PublicSettings; degraded: boolean };

async function getJson<T>(path: string, fetchImpl: Fetch, timeoutMs: number): Promise<T> {
  const res = await fetchImpl(`${API_URL}${path}`, { next: { revalidate: 60 }, signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

/** Menu + public settings for every page. Each falls back on its own, so one failing endpoint does not empty the other. */
export async function loadLayout(fetchImpl: Fetch = fetch, timeoutMs = 3000): Promise<LayoutData> {
  const [nav, settings] = await Promise.allSettled([getJson<Navigation>('/navigation', fetchImpl, timeoutMs), getJson<PublicSettings>('/settings/public', fetchImpl, timeoutMs)]);
  return {
    navigation: nav.status === 'fulfilled' && Array.isArray(nav.value?.types) ? nav.value : { types: [] },
    settings: settings.status === 'fulfilled' && settings.value?.store ? settings.value : DEFAULT_PUBLIC_SETTINGS,
    degraded: nav.status === 'rejected' || settings.status === 'rejected',
  };
}
