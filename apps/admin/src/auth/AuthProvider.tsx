// Session state for the admin SPA. On load it asks the API to refresh (the HttpOnly cookie decides whether a session
// exists), then loads /admin/me (user + permissions). A logout in any tab ends the session in every tab.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AdminApi, AdminUser } from '../api/client';

type State = { status: 'loading' } | { status: 'anonymous' } | { status: 'authenticated'; user: AdminUser; permissions: string[] };
type AuthContextValue = {
  state: State;
  api: AdminApi;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  can(permission: string): boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ api, children }: { api: AdminApi; children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const status = useRef<State['status']>('loading');
  useEffect(() => { status.current = state.status; }, [state.status]);

  const loadMe = useCallback(async () => {
    const me = await api.request<{ user: AdminUser; permissions: string[] }>('GET', '/admin/me');
    setState({ status: 'authenticated', user: me.user, permissions: me.permissions });
  }, [api]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const token = await api.refresh();
      if (!alive) return;
      if (!token) { setState({ status: 'anonymous' }); return; }
      try { await loadMe(); } catch { if (alive) setState({ status: 'anonymous' }); }
    })();
    const off = api.onSession((e) => {
      if (e === 'logout') setState({ status: 'anonymous' });
      // Another tab logged in while this one was logged out: adopt the session.
      if (e === 'token' && status.current === 'anonymous') {
        setState({ status: 'loading' });
        loadMe().catch(() => setState({ status: 'anonymous' }));
      }
    });
    return () => { alive = false; off(); };
  }, [api, loadMe]);

  const value = useMemo<AuthContextValue>(() => ({
    state,
    api,
    async login(email, password) { await api.login(email, password); await loadMe(); },
    async logout() { await api.logout(); setState({ status: 'anonymous' }); },
    can: (p) => state.status === 'authenticated' && state.permissions.includes(p),
  }), [state, api, loadMe]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
