'use client';
// Who is signed in, for every page (task 4.2). The session (lib/session.ts) lives in the browser only; the server
// render and the first client render say "loading", then the page load resumes the session if this browser has one.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { StoreSession, type Customer } from '../../lib/session';

export type AuthStatus = 'loading' | 'anonymous' | 'signed-in';
type Auth = { status: AuthStatus; user: Customer | null; session: StoreSession | null };

const AuthContext = createContext<Auth | null>(null);
let browserSession: StoreSession | null = null;
/** One session per browser tab. */
export const getBrowserSession = () => (browserSession ??= new StoreSession());

export function AuthProvider({ children, session }: { children: ReactNode; session?: StoreSession }) {
  const [s] = useState<StoreSession | null>(() => session ?? (typeof window === 'undefined' ? null : getBrowserSession()));
  const [state, setState] = useState<{ status: AuthStatus; user: Customer | null }>({ status: 'loading', user: null });
  useEffect(() => {
    if (!s) return;
    let live = true;
    const off = s.onChange((e) => setState(e.type === 'signed-out' ? { status: 'anonymous', user: null } : { status: 'signed-in', user: e.user }));
    void s.restore().then((u) => { if (live) setState(u ? { status: 'signed-in', user: u } : { status: 'anonymous', user: null }); });
    return () => { live = false; off(); };
  }, [s]);
  return <AuthContext.Provider value={{ ...state, session: s }}>{children}</AuthContext.Provider>;
}

/** The signed-in customer; outside a provider (single-component tests) nobody is signed in. */
export function useAuth(): Auth {
  return useContext(AuthContext) ?? { status: 'anonymous', user: null, session: null };
}
