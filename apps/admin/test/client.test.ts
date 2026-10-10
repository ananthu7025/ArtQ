import { describe, expect, it, vi } from 'vitest';
import { AdminApi, ApiError } from '../src/api/client';
import { err, fakeServer } from './fake-server';

const BASE = 'http://api.test/v1';
/** In-process stand-ins for navigator.locks and BroadcastChannel shared by several "tabs". */
function sharedTabsEnv() {
  let tail: Promise<unknown> = Promise.resolve();
  const locks = { request: <T,>(_n: string, cb: () => Promise<T>) => { const run = tail.then(cb); tail = run.catch(() => undefined); return run; } };
  const listeners: ((e: MessageEvent) => void)[] = [];
  const channel = () => {
    let mine: ((e: MessageEvent) => void) | null = null;
    return {
      postMessage: (m: unknown) => { for (const l of listeners) if (l !== mine) l({ data: m } as MessageEvent); },
      addEventListener: (_t: 'message', cb: (e: MessageEvent) => void) => { mine = cb; listeners.push(cb); },
      close: () => {},
    };
  };
  return { locks, channel };
}
const api = (fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof AdminApi>[0]> = {}) => new AdminApi({ baseUrl: BASE, fetchImpl, locks: null, channel: null, ...extra });

describe('AdminApi', () => {
  it('login keeps the token in memory and sends it as a Bearer token; cookies always included', async () => {
    const seen: RequestInit[] = [];
    const s = fakeServer({ 'POST /admin/auth/login': () => [200, { accessToken: 'tok1', user: { id: 1, email: 'a@artq.in', role: 'ADMIN', name: null } }], 'GET /admin/me': () => [200, { ok: true }] });
    const f = (async (u: RequestInfo | URL, i?: RequestInit) => { seen.push(i!); return s.fetchImpl(u, i); }) as typeof fetch;
    const a = api(f);
    expect(await a.login('a@artq.in', 'pw')).toMatchObject({ email: 'a@artq.in' });
    await a.request('GET', '/admin/me');
    expect(s.calls[1]!.auth).toBe('Bearer tok1');
    expect(seen.every((i) => i.credentials === 'include')).toBe(true);
    expect(s.calls[0]!.auth).toBeNull();                                         // login itself is not Bearer-authenticated
  });

  it('a 401 triggers one refresh and one retry; concurrent 401s share a single refresh', async () => {
    let token = 'old';
    const s = fakeServer({
      'POST /admin/auth/refresh': async () => { await new Promise((r) => setTimeout(r, 20)); token = 'new'; return [200, { accessToken: 'new' }]; },
      'GET /admin/me': (c) => (c.auth === `Bearer ${token}` && token === 'new' ? [200, { ok: 1 }] : err(401, 'UNAUTHENTICATED')),
    });
    const a = api(s.fetchImpl);
    const rs = await Promise.all([a.request('GET', '/admin/me'), a.request('GET', '/admin/me'), a.request('GET', '/admin/me')]);
    expect(rs).toEqual([{ ok: 1 }, { ok: 1 }, { ok: 1 }]);
    expect(s.calls.filter((c) => c.path === '/admin/auth/refresh')).toHaveLength(1);
  });

  it('a failed refresh ends the session (logout event) and the original error is thrown; no retry loop', async () => {
    const s = fakeServer({ 'POST /admin/auth/refresh': () => err(401, 'SESSION_INVALID'), 'GET /admin/me': () => err(401, 'SESSION_INVALID') });
    const a = api(s.fetchImpl);
    const events: string[] = [];
    a.onSession((e) => events.push(e));
    await expect(a.request('GET', '/admin/me')).rejects.toMatchObject({ status: 401, code: 'SESSION_INVALID' });
    expect(events).toEqual(['logout']);
    expect(s.calls.map((c) => c.path)).toEqual(['/admin/me', '/admin/auth/refresh']);
  });

  it('two tabs: the one that waited for the lock adopts the broadcast token instead of refreshing again', async () => {
    const env = sharedTabsEnv();
    const s = fakeServer({ 'POST /admin/auth/refresh': async () => { await new Promise((r) => setTimeout(r, 20)); return [200, { accessToken: 'shared' }]; } });
    const tabA = api(s.fetchImpl, { locks: env.locks, channel: env.channel() });
    const tabB = api(s.fetchImpl, { locks: env.locks, channel: env.channel() });
    const [ta, tb] = await Promise.all([tabA.refresh(), tabB.refresh()]);
    expect([ta, tb]).toEqual(['shared', 'shared']);
    expect(s.calls.filter((c) => c.path === '/admin/auth/refresh')).toHaveLength(1);
  });

  it('a logout in another tab ends this tab’s session too', async () => {
    const env = sharedTabsEnv();
    const s = fakeServer({ 'POST /admin/auth/logout': () => [200, { ok: true }], 'POST /admin/auth/login': () => [200, { accessToken: 't', user: {} }] });
    const tabA = api(s.fetchImpl, { locks: env.locks, channel: env.channel() });
    const tabB = api(s.fetchImpl, { locks: env.locks, channel: env.channel() });
    await tabA.login('a@x.in', 'p');
    expect(tabB.hasToken).toBe(true);                                            // the login token was shared
    const events: string[] = [];
    tabB.onSession((e) => events.push(e));
    await tabA.logout();
    expect(tabB.hasToken).toBe(false);
    expect(events).toEqual(['logout']);
  });

  it('STEP_UP_REQUIRED asks the UI and retries once on success; a cancelled step-up rethrows', async () => {
    let stepped = false;
    const s = fakeServer({ 'POST /admin/refunds': () => (stepped ? [201, { ok: 1 }] : err(401, 'STEP_UP_REQUIRED')) });
    const a = api(s.fetchImpl);
    const handler = vi.fn(async () => { stepped = true; return true; });
    a.setStepUpHandler(handler);
    expect(await a.request('POST', '/admin/refunds', { body: {} })).toEqual({ ok: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
    stepped = false;
    a.setStepUpHandler(async () => false);
    await expect(a.request('POST', '/admin/refunds', { body: {} })).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('download: STEP_UP_REQUIRED asks once and retries; cancelled rethrows; a second refusal is not retried again', async () => {
    let stepped = false;
    const s = fakeServer({ 'GET /admin/newsletter/export.csv': () => (stepped ? [200, 'csv'] : err(401, 'STEP_UP_REQUIRED')) });
    const a = api(s.fetchImpl);
    const handler = vi.fn(async () => { stepped = true; return true; });
    a.setStepUpHandler(handler);
    expect(await (await a.download('/admin/newsletter/export.csv')).text()).toBe('"csv"');
    expect(handler).toHaveBeenCalledTimes(1);
    stepped = false;
    a.setStepUpHandler(async () => false);
    await expect(a.download('/admin/newsletter/export.csv')).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const stubborn = vi.fn(async () => true);   // the password was accepted but the server still refuses: no loop
    a.setStepUpHandler(stubborn);
    const before = s.calls.length;
    await expect(a.download('/admin/newsletter/export.csv')).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(stubborn).toHaveBeenCalledTimes(1);
    expect(s.calls.length - before).toBe(2);
  });

  it('network failures become ApiError NETWORK; error bodies keep code, message and details', async () => {
    const down = api((async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch);
    await expect(down.request('GET', '/x')).rejects.toMatchObject({ status: 0, code: 'NETWORK' });
    const s = fakeServer({ 'POST /x': () => err(409, 'VERSION_CONFLICT', 'Changed', { version: 4 }) });
    const e = await api(s.fetchImpl).request('POST', '/x', { body: {} }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 409, code: 'VERSION_CONFLICT', message: 'Changed', details: { version: 4 } });
  });

  it('builds query strings, skipping empty values', async () => {
    const s = fakeServer({ 'GET /admin/audit-logs': () => [200, {}] });
    await api(s.fetchImpl).request('GET', '/admin/audit-logs', { query: { page: 2, action: 'media.', entity: '', actorId: undefined, sort: null } });
    expect(Object.fromEntries(s.calls[0]!.query)).toEqual({ page: '2', action: 'media.' });
  });
});
