// Customer session in the browser (architecture.md §5.1–5.3, task 4.2). The access token lives in memory only; the
// refresh token is the HttpOnly cookie on the API host (Path=/v1/auth), sent with `credentials: 'include'`.
// Tabs coordinate: one tab at a time refreshes under the Web Lock `aq-refresh` and broadcasts the new token (and the
// user) on BroadcastChannel `aq-auth`; a tab that waited for the lock adopts it instead of refreshing again. A logout
// in one tab logs out every tab. A 401 triggers one coordinated refresh and one retry.
// Refresh on page load only when this browser has signed in before (the `aq_signed_in` hint in localStorage): a guest
// never calls refresh, so guests do not get a 401 on every page or spend the per-IP refresh budget (§5.3 note).
import { API_URL, ApiError } from './api';

export type Customer = { id: number; name: string | null; email: string; emailVerified: boolean; phone: string | null; marketingOptIn: boolean };
type Locks = { request<T>(name: string, cb: () => Promise<T>): Promise<T> };
type Channel = { postMessage(m: unknown): void; addEventListener(t: 'message', cb: (e: MessageEvent) => void): void; close(): void };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Message = { type: 'token'; token: string; user: Customer } | { type: 'logout' } | { type: 'user'; user: Customer };
export type SessionEvent = { type: 'signed-in'; user: Customer } | { type: 'user'; user: Customer } | { type: 'signed-out' };
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export const HINT_KEY = 'aq_signed_in';
const NETWORK = 'We could not reach the store. Check your connection and try again.';

export type SessionOptions = { baseUrl?: string; fetchImpl?: typeof fetch; locks?: Locks | null; channel?: Channel | null; storage?: Storage | null };

export class StoreSession {
  private token: string | null = null;
  private user: Customer | null = null;
  private refreshing: Promise<boolean> | null = null;
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly locks: Locks | null;
  private readonly channel: Channel | null;
  private readonly storage: Storage | null;

  constructor(o: SessionOptions = {}) {
    this.baseUrl = o.baseUrl ?? API_URL;
    this.fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
    this.locks = o.locks === undefined ? (typeof navigator !== 'undefined' && 'locks' in navigator ? (navigator.locks as unknown as Locks) : null) : o.locks;
    this.channel = o.channel === undefined ? (typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('aq-auth') : null) : o.channel;
    (this.channel as { unref?: () => void } | null)?.unref?.();   // Node (tests): never keeps the process alive
    this.storage = o.storage === undefined ? (typeof window !== 'undefined' ? safeStorage() : null) : o.storage;
    this.channel?.addEventListener('message', (e: MessageEvent) => {
      const m = e.data as Message;
      if (m?.type === 'token' && typeof m.token === 'string' && m.user) {
        const was = this.user;
        this.token = m.token; this.user = m.user;
        this.emit(was ? { type: 'user', user: m.user } : { type: 'signed-in', user: m.user });
      }
      if (m?.type === 'user' && m.user && this.user) { this.user = m.user; this.emit({ type: 'user', user: m.user }); }
      if (m?.type === 'logout') this.clear(false);
    });
  }

  get currentUser() { return this.user; }
  get signedIn() { return this.token !== null; }

  onChange(cb: (e: SessionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
  private emit(e: SessionEvent) { for (const l of this.listeners) l(e); }

  private hint(on: boolean) {
    try { if (on) this.storage?.setItem(HINT_KEY, '1'); else this.storage?.removeItem(HINT_KEY); } catch { /* storage blocked */ }
  }
  private get hinted() { try { return this.storage?.getItem(HINT_KEY) === '1'; } catch { return false; } }

  private async raw(method: Method, path: string, body?: unknown, auth = true): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, credentials: 'include', cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch {
      throw new ApiError(0, 'NETWORK', NETWORK);
    }
  }

  private static async error(res: Response): Promise<ApiError> {
    const b = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
    return new ApiError(res.status, b?.error?.code ?? 'INTERNAL', b?.error?.message ?? 'Something went wrong. Please try again.', b?.error?.details);
  }

  private adopt(token: string, user: Customer) {
    const was = this.user;
    this.token = token; this.user = user;
    this.hint(true);
    this.channel?.postMessage({ type: 'token', token, user } satisfies Message);
    this.emit(was && was.id === user.id ? { type: 'user', user } : { type: 'signed-in', user });
  }

  /** Forgets the session in this tab (and, when `broadcast`, in every tab). */
  private clear(broadcast: boolean) {
    const was = this.token !== null || this.user !== null;
    this.token = null; this.user = null;
    this.hint(false);
    if (broadcast) this.channel?.postMessage({ type: 'logout' } satisfies Message);
    if (was || broadcast) this.emit({ type: 'signed-out' });
  }

  /** On page load: resumes the session when this browser has one. Resolves the user or null. */
  async restore(): Promise<Customer | null> {
    if (this.user) return this.user;
    if (!this.hinted) return null;
    await this.refresh();
    return this.user;
  }

  /** Coordinated refresh. True when a fresh token is in memory; false (and signed out) when the session has ended. */
  refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    const before = this.token;
    const run = async (): Promise<boolean> => {
      // Another tab may have refreshed while this one waited for the lock: adopt its token.
      if (this.token && this.token !== before) return true;
      let res: Response;
      try { res = await this.raw('POST', '/auth/refresh', {}, false); } catch { return false; }   // offline: keep the hint, try again later
      if (res.ok) {
        const b = (await res.json()) as { accessToken: string; user: Customer };
        this.adopt(b.accessToken, b.user);
        return true;
      }
      if (res.status === 401 || res.status === 403) this.clear(true);
      return false;
    };
    this.refreshing = (this.locks ? this.locks.request('aq-refresh', run) : run()).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** An API call as this customer (Bearer when signed in; cookies always, for the cart). One refresh + retry on 401. */
  async request<T>(method: Method, path: string, body?: unknown, retried = false): Promise<T> {
    const res = await this.raw(method, path, body);
    if (res.ok) return (await res.json().catch(() => null)) as T;
    const err = await StoreSession.error(res);
    if (res.status === 401 && !retried && (err.code === 'UNAUTHENTICATED' || err.code === 'SESSION_INVALID') && (this.token || this.hinted)) {
      if (await this.refresh()) return this.request(method, path, body, true);
      if (path.startsWith('/me') || path.startsWith('/auth/')) throw err;
      return this.request(method, path, body, true);   // the cart works without an account: retry as a guest
    }
    throw err;
  }

  /** Login, signup verification, email-code login or set-password: stores the session and tells the other tabs. */
  async signIn(path: '/auth/login' | '/auth/signup/verify' | '/auth/otp/verify' | '/auth/set-password', body: unknown): Promise<Customer> {
    const res = await this.raw('POST', path, body, false);
    if (!res.ok) throw await StoreSession.error(res);
    const b = (await res.json()) as { accessToken: string; user: Customer };
    this.adopt(b.accessToken, b.user);
    return b.user;
  }

  /** The profile changed in this tab: update every tab. */
  updateUser(user: Customer) {
    if (!this.user) return;
    this.user = user;
    this.channel?.postMessage({ type: 'user', user } satisfies Message);
    this.emit({ type: 'user', user });
  }

  /** Logs out here and in every tab. The server call is best effort: the session is forgotten locally either way. */
  async logout(): Promise<void> {
    await this.raw('POST', '/auth/logout', {}, false).catch(() => null);
    this.clear(true);
  }

  /** The server already ended every session (password or email change, account deletion): forget it everywhere. */
  ended() { this.clear(true); }

  dispose() { this.channel?.close(); }
}

function safeStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}
