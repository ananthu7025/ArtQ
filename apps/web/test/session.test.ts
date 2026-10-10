// Task 4.2: the browser session (lib/session.ts): refresh only when this browser has signed in, one refresh at a time
// across tabs (Web Lock + BroadcastChannel), 401 → refresh → retry, logout everywhere. Plus safeNext and withRepeat.
import { changePasswordBody } from '@artq/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { withRepeat } from '../lib/form-schemas';
import { safeNext } from '../lib/safe-next';
import { HINT_KEY, StoreSession, type Customer, type SessionEvent } from '../lib/session';

const BASE = 'https://api.test/v1';
const USER: Customer = { id: 7, name: 'Asha Menon', email: 'asha@example.com', emailVerified: true, phone: null, marketingOptIn: false };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const err = (status: number, code: string) => json({ error: { code, message: code } }, status);

/** One in-memory "browser": shared storage, a broadcast bus and a lock, like tabs of the same site. */
function browser() {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const tabs: ((e: MessageEvent) => void)[] = [];
  const channel = () => {
    let mine: ((e: MessageEvent) => void) | null = null;
    return {
      postMessage: (m: unknown) => { for (const t of tabs) if (t !== mine) t({ data: structuredClone(m) } as MessageEvent); },
      addEventListener: (_t: 'message', cb: (e: MessageEvent) => void) => { mine = cb; tabs.push(cb); },
      close: () => {},
    };
  };
  let queue = Promise.resolve();
  const locks = { request: <T,>(_n: string, cb: () => Promise<T>) => { const run = queue.then(cb); queue = run.then(() => undefined, () => undefined); return run; } };
  return { store, storage, channel, locks };
}

let fetchMock: ReturnType<typeof vi.fn>;
let calls: { method: string; path: string; auth: string | null }[];
let routes: Record<string, (n: number) => Response | Promise<Response>>;
beforeEach(() => {
  calls = []; routes = {};
  fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace(BASE, '');
    const method = init.method ?? 'GET';
    calls.push({ method, path, auth: (init.headers as Record<string, string>).Authorization ?? null });
    expect(init.credentials).toBe('include');
    const r = routes[`${method} ${path}`];
    if (!r) throw new TypeError('Failed to fetch');
    return r(calls.filter((c) => c.path === path).length);
  });
});
afterEach(() => vi.restoreAllMocks());
const tab = (b: ReturnType<typeof browser>) => new StoreSession({ baseUrl: BASE, fetchImpl: fetchMock as unknown as typeof fetch, storage: b.storage, channel: b.channel(), locks: b.locks });

describe('page load', () => {
  it('a browser that never signed in makes no refresh call (guests get no 401s)', async () => {
    const s = tab(browser());
    expect(await s.restore()).toBeNull();
    expect(calls).toEqual([]);
  });
  it('a signed-in browser refreshes once and resumes the session', async () => {
    const b = browser(); b.store.set(HINT_KEY, '1');
    routes['POST /auth/refresh'] = () => json({ accessToken: 'A1', user: USER });
    const s = tab(b);
    expect(await s.restore()).toEqual(USER);
    expect(s.signedIn).toBe(true);
    expect(calls).toEqual([{ method: 'POST', path: '/auth/refresh', auth: null }]);
  });
  it('an ended session (401) clears the hint, so the next load is a guest load', async () => {
    const b = browser(); b.store.set(HINT_KEY, '1');
    routes['POST /auth/refresh'] = () => err(401, 'SESSION_INVALID');
    expect(await tab(b).restore()).toBeNull();
    expect(b.store.has(HINT_KEY)).toBe(false);
  });
  it('the API unreachable while refreshing keeps the hint (offline is not a logout)', async () => {
    const b = browser(); b.store.set(HINT_KEY, '1');
    expect(await tab(b).restore()).toBeNull();
    expect(b.store.get(HINT_KEY)).toBe('1');
  });
});

describe('tabs', () => {
  it('three tabs loading together: one refresh call; the others adopt the broadcast token (AT-11)', async () => {
    const b = browser(); b.store.set(HINT_KEY, '1');
    routes['POST /auth/refresh'] = () => json({ accessToken: 'A1', user: USER });
    const [t1, t2, t3] = [tab(b), tab(b), tab(b)];
    const users = await Promise.all([t1.restore(), t2.restore(), t3.restore()]);
    expect(users.map((u) => u?.id)).toEqual([7, 7, 7]);
    expect(calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(1);
  });
  it('signing in in one tab signs in the others; logging out in one logs out all', async () => {
    const b = browser();
    routes['POST /auth/login'] = () => json({ accessToken: 'A1', user: USER });
    routes['POST /auth/logout'] = () => json({ ok: true });
    const t1 = tab(b); const t2 = tab(b);
    const seen: SessionEvent[] = [];
    t2.onChange((e) => seen.push(e));
    await t1.signIn('/auth/login', { email: USER.email, password: 'x' });
    expect(b.store.get(HINT_KEY)).toBe('1');
    expect([t2.signedIn, t2.currentUser?.id]).toEqual([true, 7]);
    await t1.logout();
    expect([t1.signedIn, t2.signedIn, b.store.has(HINT_KEY)]).toEqual([false, false, false]);
    expect(seen.map((e) => e.type)).toEqual(['signed-in', 'signed-out']);
  });
  it('a profile change reaches the other tabs; ended() (password/email change, deletion) signs out every tab without a server call', async () => {
    const b = browser();
    routes['POST /auth/login'] = () => json({ accessToken: 'A1', user: USER });
    const t1 = tab(b); const t2 = tab(b);
    await t1.signIn('/auth/login', {});
    t1.updateUser({ ...USER, name: 'Asha M' });
    expect(t2.currentUser?.name).toBe('Asha M');
    const n = calls.length;
    t1.ended();
    expect([t1.signedIn, t2.signedIn, calls.length]).toEqual([false, false, n]);
  });
});

describe('requests', () => {
  it('sends the Bearer token; a 401 refreshes once and retries with the new token', async () => {
    const b = browser();
    routes['POST /auth/login'] = () => json({ accessToken: 'OLD', user: USER });
    routes['POST /auth/refresh'] = () => json({ accessToken: 'NEW', user: USER });
    routes['GET /me/addresses'] = (n) => (n === 1 ? err(401, 'UNAUTHENTICATED') : json({ data: [] }));
    const s = tab(b);
    await s.signIn('/auth/login', {});
    expect(await s.request('GET', '/me/addresses')).toEqual({ data: [] });
    expect(calls.filter((c) => c.path === '/me/addresses').map((c) => c.auth)).toEqual(['Bearer OLD', 'Bearer NEW']);
  });
  it('two requests failing together share one refresh', async () => {
    routes['POST /auth/login'] = () => json({ accessToken: 'OLD', user: USER });
    routes['POST /auth/refresh'] = () => json({ accessToken: 'NEW', user: USER });
    routes['GET /me/wishlist'] = (n) => (n <= 2 ? err(401, 'UNAUTHENTICATED') : json({ productIds: [] }));
    const s = tab(browser());
    await s.signIn('/auth/login', {});
    await Promise.all([s.request('GET', '/me/wishlist'), s.request('GET', '/me/wishlist')]);
    expect(calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(1);
  });
  it('session over: an account call fails with the 401 (signed out); a cart call carries on as a guest', async () => {
    routes['POST /auth/login'] = () => json({ accessToken: 'OLD', user: USER });
    routes['POST /auth/refresh'] = () => err(401, 'SESSION_INVALID');
    routes['GET /me'] = () => err(401, 'SESSION_INVALID');
    routes['GET /cart'] = () => (calls.at(-1)!.auth ? err(401, 'SESSION_INVALID') : json({ items: [] }));
    const s = tab(browser());
    await s.signIn('/auth/login', {});
    await expect(s.request('GET', '/me')).rejects.toMatchObject({ status: 401, code: 'SESSION_INVALID' });
    expect(s.signedIn).toBe(false);
    await s.signIn('/auth/login', {});
    expect(await s.request('GET', '/cart')).toEqual({ items: [] });
    expect(calls.filter((c) => c.path === '/cart').map((c) => c.auth)).toEqual(['Bearer OLD', null]);
  });
  it('other errors pass through untouched, with code and details; network failure → NETWORK', async () => {
    routes['POST /me/addresses'] = () => json({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: [{ location: 'body', path: 'pincode', message: 'This pincode is in Kerala' }] } }, 400);
    const s = tab(browser());
    const e = await s.request('POST', '/me/addresses', {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', details: [{ path: 'pincode' }] });
    expect(calls.filter((c) => c.path === '/auth/refresh')).toEqual([]);   // a guest's 400 never refreshes
    await expect(s.request('GET', '/nowhere')).rejects.toMatchObject({ code: 'NETWORK' });
  });
  it('a failed sign-in stores nothing', async () => {
    const b = browser();
    routes['POST /auth/login'] = () => err(401, 'INVALID_CREDENTIALS');
    const s = tab(b);
    await expect(s.signIn('/auth/login', {})).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect([s.signedIn, b.store.has(HINT_KEY)]).toEqual([false, false]);
  });
});

describe('safeNext', () => {
  it.each([
    ['/account/addresses', '/account/addresses'], ['/wishlist?x=1', '/wishlist?x=1'],
    [null, '/account'], ['', '/account'], ['//evil.example', '/account'], ['/\\evil.example', '/account'], ['https://evil.example', '/account'], ['account', '/account'], ['javascript:alert(1)', '/account'],
  ])('%s → %s', (next, to) => { expect(safeNext(next)).toBe(to); });
});

describe('withRepeat (client-only "type it again" on a shared schema)', () => {
  const form = withRepeat(changePasswordBody, 'newPassword');
  const issues = (v: unknown) => { const r = form.safeParse(v); return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`); };
  it('valid → the shared output plus repeat', () => {
    expect(form.parse({ currentPassword: 'old-pass-1', newPassword: 'new-pass-1', repeat: 'new-pass-1' })).toEqual({ currentPassword: 'old-pass-1', newPassword: 'new-pass-1', repeat: 'new-pass-1' });
  });
  it('the shared rules apply unchanged (8+, letter and number, differs from the current one) and a mismatch is reported with them', () => {
    expect(issues({ currentPassword: 'old-pass-1', newPassword: 'abcdefgh', repeat: 'x' })).toEqual(['newPassword: Use at least one letter and one number', 'repeat: The passwords do not match']);
    expect(issues({ currentPassword: 'same-pass-1', newPassword: 'same-pass-1', repeat: 'same-pass-1' })).toEqual(['newPassword: Choose a password different from the current one']);
    expect(issues({ currentPassword: '', newPassword: 'new-pass-1', repeat: 'new-pass-1' })).toEqual(['currentPassword: Enter your password']);
  });
});
