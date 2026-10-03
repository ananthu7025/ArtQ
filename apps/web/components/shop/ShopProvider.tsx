'use client';
// The cart, the mini-cart, the wishlist and "add to cart" for every page (tasks 3.4, 4.2, 4.5). The cart lives in the
// API (guest: cookie on the API host; signed in: the account's cart, on any device). The wishlist is kept in this browser for guests (shared
// between tabs) and in the account once signed in; at sign-in the browser's list joins the account's and is cleared.
import type { CartView, ProductCard } from '@artq/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ApiError, clientRequest } from '../../lib/api';
import { useAuth } from '../account/AuthProvider';

const WISHLIST_KEY = 'aq_wishlist';
const WISHLIST_MAX = 100;

export type MiniCart = { variantId: number; quantity: number; name: string; /** The page it was opened on. */ path: string; /** Where focus goes when it closes. */ returnTo: HTMLElement | null };
type CartMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

type Shop = {
  cartCount: number;
  /** The re-priced cart (null until loaded); `cartFailed` when it could not be loaded. */
  cart: CartView | null;
  cartFailed: boolean;
  /** A cart call (`/cart…`) with the estimate pincode; the returned cart replaces the one shown. Throws ApiError. */
  cartCall: (method: CartMethod, path: string, body?: unknown) => Promise<CartView>;
  reloadCart: () => void;
  /** The pincode for the shipping estimate (shared with the product page's delivery check). */
  pincode: string | null;
  setPincode: (pincode: string | null) => void;
  /** The drawer shown after an add (product.md §5.7). */
  miniCart: MiniCart | null;
  closeMiniCart: () => void;
  wishlist: number[];
  /** False while the account's wishlist (or the session) is still loading. */
  wishlistReady: boolean;
  /** Saves or removes at once (the account is updated in the background); returns true when now saved. */
  toggleWishlist: (productId: number) => boolean;
  /** Adds and opens the mini-cart (unless `quiet`, e.g. Buy now); returns the error message instead of throwing. */
  addToCart: (variantId: number, quantity: number, name: string, opts?: { quiet?: boolean; returnFocus?: HTMLElement | null }) => Promise<{ ok: true } | { ok: false; message: string; code: string }>;
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

// ── Estimate pincode (localStorage `aq_pincode`, also written by the product page's delivery check) ──
const PINCODE_KEY = 'aq_pincode';
const pinListeners = new Set<() => void>();
function readPincode(): string | null {
  try { const v = window.localStorage.getItem(PINCODE_KEY); return v && /^[1-9]\d{5}$/.test(v) ? v : null; } catch { return null; }
}
export function writePincode(pin: string | null) {
  try { if (pin) window.localStorage.setItem(PINCODE_KEY, pin); else window.localStorage.removeItem(PINCODE_KEY); } catch { /* storage blocked */ }
  for (const l of pinListeners) l();
}
function subscribePincode(l: () => void) {
  pinListeners.add(l);
  const onStorage = (e: StorageEvent) => { if (e.key === PINCODE_KEY) l(); };
  window.addEventListener('storage', onStorage);
  return () => { pinListeners.delete(l); window.removeEventListener('storage', onStorage); };
}

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
  const [cart, setCart] = useState<CartView | null>(null);
  const [cartFailed, setCartFailed] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [miniCart, setMiniCart] = useState<MiniCart | null>(null);
  const pincode = useSyncExternalStore(subscribePincode, readPincode, () => null);
  const [whatsappTopic, setWhatsappTopic] = useState<string | null>(null);
  const local = useSyncExternalStore(subscribeWishlist, readWishlist, () => EMPTY);
  const [saved, setSaved] = useState<{ userId: number; ids: number[] } | null>(null);
  const signedIn = status === 'signed-in';
  const userId = user?.id ?? null;
  // The account's list, only for the customer it was loaded for (another login in this tab starts empty).
  const account = signedIn && saved && saved.userId === userId ? saved.ids : null;
  const setAccount = useCallback((ids: number[]) => { if (userId !== null) setSaved({ userId, ids }); }, [userId]);

  const withPin = useCallback((path: string) => (pincode ? `${path}${path.includes('?') ? '&' : '?'}pincode=${pincode}` : path), [pincode]);
  // The cart follows the session (a guest's own, or the account's after sign-in; a fresh one after logout) and the
  // estimate pincode.
  useEffect(() => {
    if (status === 'loading') return;
    let live = true;
    api<CartView>('GET', withPin('/cart'))
      .then((c) => { if (live) { setCart(c); setCartFailed(false); } })
      .catch(() => { if (live) setCartFailed(true); });
    return () => { live = false; };
  }, [api, status, userId, withPin, reloads]);
  const cartCall = useCallback<Shop['cartCall']>(async (method, path, body) => {
    const c = await api<CartView>(method, withPin(path), body);
    setCart(c); setCartFailed(false);
    return c;
  }, [api, withPin]);
  const reloadCart = useCallback(() => setReloads((n) => n + 1), []);

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

  const addToCart = useCallback<Shop['addToCart']>(async (variantId, quantity, name, opts) => {
    // The control that asked (taken now: it may be disabled or gone by the time the drawer closes).
    const returnTo = opts?.returnFocus !== undefined ? opts.returnFocus : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    try {
      await cartCall('POST', '/cart/items', { variantId, quantity });
      // After the sheet that asked (if any) has closed, so the drawer gets the focus.
      if (!opts?.quiet) setTimeout(() => setMiniCart({ variantId, quantity, name, path: window.location.pathname, returnTo }), 0);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: errorText(e), code: e instanceof ApiError ? e.code : 'INTERNAL' };
    }
  }, [cartCall]);

  const wishlist = signedIn ? (account ?? EMPTY) : local;
  const wishlistReady = status === 'anonymous' || (signedIn && account !== null);
  const closeMiniCart = useCallback(() => setMiniCart(null), []);
  const value = useMemo<Shop>(() => ({
    cartCount: cart?.totals.itemCount ?? 0, cart, cartFailed, cartCall, reloadCart, pincode, setPincode: writePincode, miniCart, closeMiniCart,
    wishlist, wishlistReady, toggleWishlist, addToCart, whatsappTopic, setWhatsappTopic,
  }), [cart, cartFailed, cartCall, reloadCart, pincode, miniCart, closeMiniCart, wishlist, wishlistReady, toggleWishlist, addToCart, whatsappTopic]);
  return <ShopContext.Provider value={value}>{children}</ShopContext.Provider>;
}

/** The shop context; outside a provider (tests of single components) counts are 0 and actions are no-ops. */
export function useShop(): Shop {
  return useContext(ShopContext) ?? {
    cartCount: 0, cart: null, cartFailed: false, cartCall: async () => { throw new ApiError(0, 'INTERNAL', 'Not available'); }, reloadCart: () => {}, pincode: null, setPincode: () => {},
    miniCart: null, closeMiniCart: () => {}, wishlist: EMPTY, wishlistReady: true, toggleWishlist: () => false,
    addToCart: async () => ({ ok: false, message: 'Not available', code: 'INTERNAL' }), whatsappTopic: null, setWhatsappTopic: () => {},
  };
}
