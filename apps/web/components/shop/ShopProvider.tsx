'use client';
// Cart count, guest wishlist and "add to cart" for every page (task 3.4). The cart lives in the API (cookie on the API
// host, sent with credentials); the guest wishlist is kept in this browser until accounts arrive (task 4.2) and follows
// changes made in other tabs.
import type { CartView } from '@artq/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ApiError, clientRequest } from '../../lib/api';

const WISHLIST_KEY = 'aq_wishlist';
const WISHLIST_MAX = 100;

type Shop = {
  cartCount: number;
  wishlist: number[];
  toggleWishlist: (productId: number) => boolean;
  /** Adds and confirms with a toast; returns the error message instead of throwing (shown in the sheet). */
  addToCart: (variantId: number, quantity: number, name: string) => Promise<{ ok: true } | { ok: false; message: string; code: string }>;
};

const ShopContext = createContext<Shop | null>(null);

// ── Guest wishlist store (localStorage, shared between tabs) ──
const listeners = new Set<() => void>();
let cached: { raw: string | null; ids: number[] } = { raw: null, ids: [] };
function readWishlist(): number[] {
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(WISHLIST_KEY); } catch { /* storage blocked: an empty list */ }
  if (raw === cached.raw) return cached.ids;
  let ids: number[];
  try { const parsed: unknown = raw ? JSON.parse(raw) : []; ids = Array.isArray(parsed) ? parsed.filter((x): x is number => Number.isSafeInteger(x) && x > 0).slice(0, WISHLIST_MAX) : []; } catch { ids = []; }
  cached = { raw, ids };
  return ids;
}
function writeWishlist(ids: number[]) {
  try { window.localStorage.setItem(WISHLIST_KEY, JSON.stringify(ids)); } catch { /* storage blocked: kept for this page only */ cached = { raw: JSON.stringify(ids), ids }; }
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

export function ShopProvider({ children }: { children: ReactNode }) {
  const [cartCount, setCartCount] = useState(0);
  const wishlist = useSyncExternalStore(subscribeWishlist, readWishlist, () => EMPTY);

  useEffect(() => {
    let live = true;
    clientRequest<CartView>('GET', '/cart').then((c) => { if (live) setCartCount(c.totals.itemCount); }).catch(() => { /* count stays 0; the cart page explains */ });
    return () => { live = false; };
  }, []);

  const toggleWishlist = useCallback((productId: number) => {
    const ids = readWishlist();
    const on = !ids.includes(productId);
    writeWishlist(on ? [productId, ...ids].slice(0, WISHLIST_MAX) : ids.filter((x) => x !== productId));
    return on;
  }, []);

  const addToCart = useCallback<Shop['addToCart']>(async (variantId, quantity, name) => {
    try {
      const cart = await clientRequest<CartView>('POST', '/cart/items', { variantId, quantity });
      setCartCount(cart.totals.itemCount);
      toast(`Added ${quantity > 1 ? `${quantity} × ` : ''}${name} to your cart`);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: errorText(e), code: e instanceof ApiError ? e.code : 'INTERNAL' };
    }
  }, []);

  const value = useMemo(() => ({ cartCount, wishlist, toggleWishlist, addToCart }), [cartCount, wishlist, toggleWishlist, addToCart]);
  return <ShopContext.Provider value={value}>{children}</ShopContext.Provider>;
}

/** The shop context; outside a provider (tests of single components) counts are 0 and actions are no-ops. */
export function useShop(): Shop {
  return useContext(ShopContext) ?? { cartCount: 0, wishlist: EMPTY, toggleWishlist: () => false, addToCart: async () => ({ ok: false, message: 'Not available', code: 'INTERNAL' }) };
}
