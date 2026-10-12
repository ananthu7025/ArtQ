// Admin API client (architecture.md §5.1–5.3, §5.8). The access token lives in memory only; the refresh token is the
// HttpOnly admin cookie (Path=/v1/admin/auth), sent with `credentials: 'include'`.
// Refresh is coordinated across tabs: one tab at a time refreshes under the Web Lock `aq-admin-refresh` and broadcasts
// the new token on BroadcastChannel `aq-admin-auth`; a tab that waited for the lock adopts it instead of refreshing.
// A 401 triggers one coordinated refresh and one retry. 401 STEP_UP_REQUIRED asks the UI for a password re-check and
// retries once.

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export type Page<T> = { data: T[]; meta: { page: number; limit: number; total: number; totalPages: number } };
export type AdminUser = { id: number; name: string | null; email: string; role: 'STAFF' | 'ADMIN' | 'SUPER_ADMIN' | 'CUSTOMER' };

type Locks = { request<T>(name: string, cb: () => Promise<T>): Promise<T> };
type Channel = { postMessage(m: unknown): void; addEventListener(t: 'message', cb: (e: MessageEvent) => void): void; close(): void };
type AuthMessage = { type: 'token'; token: string } | { type: 'logout' };
export type SessionEvent = 'token' | 'logout';

export type ApiOptions = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  locks?: Locks | null;
  channel?: Channel | null;
};

export class AdminApi {
  private token: string | null = null;
  private refreshing: Promise<string | null> | null = null;
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  private readonly fetchImpl: typeof fetch;
  private readonly locks: Locks | null;
  private readonly channel: Channel | null;
  /** Set by the UI: shows the password re-check and resolves true when it succeeded. */
  private stepUpHandler: (() => Promise<boolean>) | null = null;

  setStepUpHandler(h: (() => Promise<boolean>) | null): void { this.stepUpHandler = h; }

  constructor(private readonly o: ApiOptions) {
    this.fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
    this.locks = o.locks === undefined ? (typeof navigator !== 'undefined' && 'locks' in navigator ? (navigator.locks as unknown as Locks) : null) : o.locks;
    this.channel = o.channel === undefined ? (typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('aq-admin-auth') : null) : o.channel;
    this.channel?.addEventListener('message', (e: MessageEvent) => {
      const m = e.data as AuthMessage;
      if (m?.type === 'token' && typeof m.token === 'string') { this.token = m.token; this.emit('token'); }
      if (m?.type === 'logout') { this.token = null; this.emit('logout'); }
    });
  }

  get hasToken() { return this.token !== null; }

  onSession(cb: (e: SessionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit(e: SessionEvent) { for (const l of this.listeners) l(e); }

  private async raw(method: string, path: string, body?: unknown, auth = true, extra: Record<string, string> = {}): Promise<Response> {
    const headers: Record<string, string> = { ...extra };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;
    try {
      return await this.fetchImpl(`${this.o.baseUrl}${path}`, { method, headers, credentials: 'include', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch {
      throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection and try again.');
    }
  }

  private static async error(res: Response): Promise<ApiError> {
    const b = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
    return new ApiError(res.status, b?.error?.code ?? 'HTTP_' + res.status, b?.error?.message ?? res.statusText ?? 'Request failed', b?.error?.details);
  }

  /** Coordinated refresh. Resolves the new access token, or null (and a logout event) when the session has ended. */
  refresh(): Promise<string | null> {
    if (this.refreshing) return this.refreshing;
    const before = this.token;
    const run = async (): Promise<string | null> => {
      // Another tab may have refreshed while we waited for the lock: adopt its token.
      if (this.token && this.token !== before) return this.token;
      const res = await this.raw('POST', '/admin/auth/refresh', {}, false).catch(() => null);
      if (res?.ok) {
        const b = (await res.json()) as { accessToken: string };
        this.token = b.accessToken;
        this.channel?.postMessage({ type: 'token', token: b.accessToken } satisfies AuthMessage);
        this.emit('token');
        return this.token;
      }
      if (res && (res.status === 401 || res.status === 403)) { this.token = null; this.emit('logout'); }
      return null;
    };
    this.refreshing = (this.locks ? this.locks.request('aq-admin-refresh', run) : run()).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** `headers` (e.g. Idempotency-Key) are sent again unchanged when the request is retried after a refresh or step-up. */
  async request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, o: { body?: unknown; query?: Record<string, string | number | undefined | null>; headers?: Record<string, string> } = {}, retried = { auth: false, stepUp: false }): Promise<T> {
    const qs = o.query ? Object.entries(o.query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&') : '';
    const res = await this.raw(method, qs ? `${path}?${qs}` : path, o.body, true, o.headers);
    if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
    const err = await AdminApi.error(res);
    if (res.status === 401 && err.code === 'STEP_UP_REQUIRED' && this.stepUpHandler && !retried.stepUp) {
      if (await this.stepUpHandler()) return this.request(method, path, o, { ...retried, stepUp: true });
      throw err;
    }
    if (res.status === 401 && !retried.auth && (err.code === 'UNAUTHENTICATED' || err.code === 'SESSION_INVALID')) {
      if (await this.refresh()) return this.request(method, path, o, { ...retried, auth: true });
    }
    throw err;
  }

  /** A file from an authenticated endpoint (e.g. an import result workbook), with the same refresh-and-retry as request(). */
  async download(path: string, retried = { auth: false, stepUp: false }): Promise<Blob> {
    const res = await this.raw('GET', path);
    if (res.ok) return res.blob();
    const err = await AdminApi.error(res);
    // Personal-data exports (e.g. the newsletter CSV) need a recent password re-check, like request().
    if (res.status === 401 && err.code === 'STEP_UP_REQUIRED' && this.stepUpHandler && !retried.stepUp) {
      if (await this.stepUpHandler()) return this.download(path, { ...retried, stepUp: true });
      throw err;
    }
    if (res.status === 401 && !retried.auth && (err.code === 'UNAUTHENTICATED' || err.code === 'SESSION_INVALID') && (await this.refresh())) return this.download(path, { ...retried, auth: true });
    throw err;
  }

  async login(email: string, password: string): Promise<AdminUser> {
    const res = await this.raw('POST', '/admin/auth/login', { email, password }, false);
    if (!res.ok) throw await AdminApi.error(res);
    const b = (await res.json()) as { accessToken: string; user: AdminUser };
    this.token = b.accessToken;
    this.channel?.postMessage({ type: 'token', token: b.accessToken } satisfies AuthMessage);
    this.emit('token');
    return b.user;
  }

  /** Always resolves for a well-formed email (the API never reveals whether an account exists). */
  async forgotPassword(email: string): Promise<void> {
    const res = await this.raw('POST', '/admin/auth/password/forgot', { email }, false);
    if (!res.ok) throw await AdminApi.error(res);
  }

  /** Sets a password from an invite or reset link; every session of the account ends. */
  async resetPassword(token: string, password: string): Promise<void> {
    const res = await this.raw('POST', '/admin/auth/password/reset', { token, password }, false);
    if (!res.ok) throw await AdminApi.error(res);
  }

  stepUp(password: string): Promise<{ stepUpUntil: string }> {
    return this.request('POST', '/admin/auth/step-up', { body: { password } });
  }

  async logout(): Promise<void> {
    await this.raw('POST', '/admin/auth/logout', {}, false).catch(() => null);
    this.token = null;
    this.channel?.postMessage({ type: 'logout' } satisfies AuthMessage);
    this.emit('logout');
  }

  dispose() { this.channel?.close(); }
}
