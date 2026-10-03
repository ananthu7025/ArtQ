'use client';
// Cart count, wishlist and "add to cart" for every page (tasks 3.4, 4.2). The cart lives in the API (guest: cookie on
// the API host; signed in: the account's cart, on any device). The wishlist is kept in this browser for guests (shared
// between tabs) and in the account once signed in; at sign-in the browser's list joins the account's and is cleared.
import type { CartView, ProductCard } from '@artq/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ApiError, clientRequest } from '../../lib/api';
import { useAuth } from '../account/AuthProvider';

const WISHLIST_KEY = 'aq_wishlist';
const WISHLIST_MAX = 100;

type Shop = {
  cartCount: number;
  wishlist: number[];
  /** False while the account's wishlist (or the session) is still loading. */
  wishlistReady: boolean;
  /** Saves or removes at once (the account is updated in the background); returns true when now saved. */
  toggleWishlist: (productId: number) => boolean;
  /** Adds and confirms with a toast; returns the error message instead of throwing (shown in the sheet). */
  addToCart: (variantId: number, quantity: number, name: string) => Promise<{ ok: true } | { ok: false; message: string; code: string }>;
  /** The product the floating WhatsApp button pre-fills (set by the product page). */
  whatsappTopic: string | null;
  setWhatsappTopic: (topic: string | null) => void;
};

const ShopContext = createContext<Shop | null>(null);

// ── Guest wishlist store (localStorage, shared between tabs) ──
const listeners = new Set<() => void>();
let cached: { raw: string | null; ids: number[] } = { raw: null, ids: [] };
export function readWishlist(): number[] {
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(WISHLIST_KEY); } catch { /* storage blocked: an empty list */ }
  if (raw === cached.raw) return cached.ids;
  let ids: number[];
  try { const parsed: unknown = raw ? JSON.parse(raw) : []; ids = Array.isArray(parsed) ? parsed.filter((x): x is number => Number.isSafeInteger(x) && x > 0).slice(0, WISHLIST_MAX) : []; } catch { ids = []; }
  cached = { raw, ids };
  return ids;
}
function writeWishlist(ids: number[]) {
  try {
    if (ids.length) window.localStorage.setItem(WISHLIST_KEY, JSON.stringify(ids)); else window.localStorage.removeItem(WISHLIST_KEY);
  } catch { /* storage blocked: kept for this page only */ cached = { raw: JSON.stringify(ids), ids }; }
  for (const l of listeners) l();
}
function subscribeWishlist(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => { if (e.key === WISHLIST_KEY) l(); };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(l); window.removeEventListener('storage', onStorage); };
}
const EMPTY: number[] = [];

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.code === 'RATE_LIMITED' ? 'Too many tries. Please wait a minute and try again.' : e.message;
  return 'Something went wrong. Please try again.';
}

/** A browser API call as the current customer (Bearer + refresh when signed in), or as a guest. */
export function useApi() {
  const { session } = useAuth();
  return useCallback(<T,>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown) =>
    (session ? session.request<T>(method, path, body) : clientRequest<T>(method, path, body)), [session]);
}

export type WishlistView = { productIds: number[]; data: ProductCard[] };

export function ShopProvider({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const api = useApi();
  const [cartCount, setCartCount] = useState(0);
  const [whatsappTopic, setWhatsappTopic] = useState<string | null>(null);
  const local = useSyncExternalStore(subscribeWishlist, readWishlist, () => EMPTY);
  const [saved, setSaved] = useState<{ userId: number; ids: number[] } | null>(null);
  const signedIn = status === 'signed-in';
  const userId = user?.id ?? null;
  // The account's list, only for the customer it was loaded for (another login in this tab starts empty).
  const account = signedIn && saved && saved.userId === userId ? saved.ids : null;
  const setAccount = useCallback((ids: number[]) => { if (userId !== null) setSaved({ userId, ids }); }, [userId]);

  // The cart follows the session: a guest's own, or the account's after sign-in; a fresh one after logout.
  useEffect(() => {
    if (status === 'loading') return;
    let live = true;
    api<CartView>('GET', '/cart').then((c) => { if (live) setCartCount(c.totals.itemCount); }).catch(() => { if (live) setCartCount(0); });
    return () => { live = false; };
  }, [api, status, userId]);

  // At sign-in the browser's wishlist joins the account's (then the browser list is cleared).
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    const ids = readWishlist();
    (ids.length ? api<WishlistView>('POST', '/me/wishlist/merge', { productIds: ids }) : api<WishlistView>('GET', '/me/wishlist'))
      .then((w) => { if (!live) return; setAccount(w.productIds); if (ids.length) writeWishlist([]); })
      .catch(() => { if (live) setAccount([]); });
    return () => { live = false; };
  }, [api, signedIn, userId, setAccount]);

  const toggleWishlist = useCallback((productId: number) => {
    if (!signedIn) {
      const ids = readWishlist();
      const on = !ids.includes(productId);
      writeWishlist(on ? [productId, ...ids].slice(0, WISHLIST_MAX) : ids.filter((x) => x !== productId));
      return on;
    }
    const before = account ?? [];
    const on = !before.includes(productId);
    setAccount(on ? [productId, ...before].slice(0, WISHLIST_MAX) : before.filter((x) => x !== productId));
    api<WishlistView & { saved: boolean }>('POST', '/me/wishlist/toggle', { productId })
      .then((w) => setAccount(w.productIds))
      .catch((e: unknown) => { setAccount(before); toast.error(`Your wishlist was not updated. ${errorText(e)}`); });
    return on;
  }, [signedIn, account, api, setAccount]);

  const addToCart = useCallback<Shop['addToCart']>(async (variantId, quantity, name) => {
    try {
      const cart = await api<CartView>('POST', '/cart/items', { variantId, quantity });
      setCartCount(cart.totals.itemCount);
      toast(`Added ${quantity > 1 ? `${quantity} × ` : ''}${name} to your cart`);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: errorText(e), code: e instanceof ApiError ? e.code : 'INTERNAL' };
    }
  }, [api]);

  const wishlist = signedIn ? (account ?? EMPTY) : local;
  const wishlistReady = status === 'anonymous' || (signedIn && account !== null);
  const value = useMemo(() => ({ cartCount, wishlist, wishlistReady, toggleWishlist, addToCart, whatsappTopic, setWhatsappTopic }), [cartCount, wishlist, wishlistReady, toggleWishlist, addToCart, whatsappTopic]);
  return <ShopContext.Provider value={value}>{children}</ShopContext.Provider>;
}

/** The shop context; outside a provider (tests of single components) counts are 0 and actions are no-ops. */
export function useShop(): Shop {
  return useContext(ShopContext) ?? { cartCount: 0, wishlist: EMPTY, wishlistReady: true, toggleWishlist: () => false, addToCart: async () => ({ ok: false, message: 'Not available', code: 'INTERNAL' }), whatsappTopic: null, setWhatsappTopic: () => {} };
}
