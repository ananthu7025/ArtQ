// lib/api.ts: layout data with per-endpoint fallbacks, and the browser POST helper's error mapping.
import { DEFAULT_PUBLIC_SETTINGS, type PublicSettings } from '@artq/shared';
import { describe, expect, it, vi } from 'vitest';
import { API_URL, apiPost, ApiError, clientRequest, loadLayout, publicGet } from '../lib/api';

const NAV = { types: [{ id: 1, name: 'Resins', slug: 'resins', href: '/type/resins', categories: [] }] };
const SETTINGS: PublicSettings = { ...DEFAULT_PUBLIC_SETTINGS, announcement: { enabled: true, messages: ['Diwali sale'] } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('loadLayout', () => {
  it('fetches the menu and public settings with 60 s revalidation', async () => {
    const f = vi.fn(async (url: string) => json(url.endsWith('/navigation') ? NAV : SETTINGS));
    const r = await loadLayout(f);
    expect(r).toEqual({ navigation: NAV, settings: SETTINGS, degraded: false });
    expect(f.mock.calls.map((c) => c[0]).sort()).toEqual([`${API_URL}/navigation`, `${API_URL}/settings/public`]);
    for (const [, init] of f.mock.calls as unknown as [string, { next: { revalidate: number }; signal: AbortSignal }][]) {
      expect(init.next).toEqual({ revalidate: 60 });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('API down: the page still renders with an empty menu and the default settings', async () => {
    const r = await loadLayout(async () => { throw new TypeError('fetch failed'); });
    expect(r).toEqual({ navigation: { types: [] }, settings: DEFAULT_PUBLIC_SETTINGS, degraded: true });
  });

  it('one endpoint failing (500) does not empty the other', async () => {
    const r = await loadLayout(async (url) => (url.endsWith('/navigation') ? json({ error: { code: 'INTERNAL' } }, 500) : json(SETTINGS)));
    expect(r.navigation).toEqual({ types: [] });
    expect(r.settings).toEqual(SETTINGS);
    expect(r.degraded).toBe(true);
  });

  it('a slow API is cut off after the timeout instead of holding the page', async () => {
    const hang = (_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)); });
    const started = Date.now();
    const r = await loadLayout(hang, 50);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.degraded).toBe(true);
    expect(r.settings).toEqual(DEFAULT_PUBLIC_SETTINGS);
  });

  it('an unexpected body shape is treated as a failure, not rendered', async () => {
    const r = await loadLayout(async () => json({ hello: 'world' }));
    expect(r.navigation).toEqual({ types: [] });
    expect(r.settings).toEqual(DEFAULT_PUBLIC_SETTINGS);
  });
});

describe('publicGet (server, prerendered pages)', () => {
  it('fetches an allow-listed path without cookies, revalidating every 60 s', async () => {
    const f = vi.fn(async () => json(NAV));
    expect(await publicGet('/navigation', f)).toEqual(NAV);
    expect(f).toHaveBeenCalledWith(`${API_URL}/navigation`, expect.objectContaining({ credentials: 'omit', next: { revalidate: 60 } }));
  });

  it.each(['/me', '/cart', '/checkout', '/orders/AQ1001', '/products/epoxy/availability', '/pincodes/682001/serviceability', '/admin/products', '/auth/refresh'])(
    'refuses %s (personal or live data never goes into a cached page) without calling the API', async (path) => {
      const f = vi.fn(async () => json({}));
      await expect(publicGet(path, f)).rejects.toThrow(/not a public, cacheable API path/);
      expect(f).not.toHaveBeenCalled();
    });

  it('a non-OK answer is an error (the caller decides the fallback)', async () => {
    await expect(publicGet('/navigation', async () => json({ error: {} }, 503))).rejects.toThrow('/navigation → 503');
  });
});

describe('apiPost', () => {
  it('posts JSON from the browser with the customer\'s cookies, never cached, and returns the body', async () => {
    const f = vi.fn(async () => json({ status: 'SUBSCRIBED' }, 201));
    expect(await apiPost('/newsletter/subscribe', { email: 'a@b.in' }, f)).toEqual({ status: 'SUBSCRIBED' });
    expect(f).toHaveBeenCalledWith(`${API_URL}/newsletter/subscribe`, expect.objectContaining({ method: 'POST', credentials: 'include', cache: 'no-store', body: '{"email":"a@b.in"}' }));
  });

  it('clientRequest GET sends no body and no Content-Type', async () => {
    const f = vi.fn(async () => json({ items: [] }));
    await clientRequest('GET', '/cart', undefined, f);
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init).toMatchObject({ method: 'GET', credentials: 'include', cache: 'no-store' });
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Accept: 'application/json' });
  });

  it('an API error keeps its status, code, message and details', async () => {
    const f = async () => json({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: [{ location: 'body', path: 'email', message: 'Enter a valid email address' }] } }, 400);
    const e = await apiPost('/x', {}, f).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', details: [{ path: 'email' }] });
  });

  it('no connection → NETWORK with a message a customer understands; a non-JSON error → INTERNAL', async () => {
    await expect(apiPost('/x', {}, async () => { throw new TypeError('Failed to fetch'); })).rejects.toMatchObject({ status: 0, code: 'NETWORK', message: 'We could not reach the store. Check your connection and try again.' });
    await expect(apiPost('/x', {}, async () => new Response('<html>Bad gateway</html>', { status: 502 }))).rejects.toMatchObject({ status: 502, code: 'INTERNAL' });
  });
});
