'use client';
// /wishlist (product.md §5.10): the saved products, newest first. A guest's list is kept in this browser; a signed-in
// customer's is in the account (any device). Products that are no longer for sale stay saved but are not shown.
// Removing with ♡ takes the card away at once.
import type { ProductCard as Card } from '@artq/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { clientRequest } from '../../lib/api';
import { FormAlert, primaryButton, textLink } from '../form/fields';
import { ProductCard } from '../product/ProductCard';
import { useShop } from '../shop/ShopProvider';
import { Loading } from './auth-shared';
import { useAuth } from './AuthProvider';

const BATCH = 24;   // GET /products/by-ids takes up to 24 ids

export function WishlistView() {
  const { status } = useAuth();
  const { wishlist, wishlistReady } = useShop();
  const [cards, setCards] = useState<Map<number, Card | null>>(new Map());
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const missing = wishlist.filter((id) => !cards.has(id));
  const key = missing.join(',');

  useEffect(() => {
    if (!wishlistReady || !key) return;
    let live = true;
    const ids = key.split(',').map(Number);
    const batches = Array.from({ length: Math.ceil(ids.length / BATCH) }, (_, i) => ids.slice(i * BATCH, (i + 1) * BATCH));
    Promise.all(batches.map((b) => clientRequest<{ data: Card[] }>('GET', `/products/by-ids?ids=${b.join(',')}`)))
      .then((rs) => {
        if (!live) return;
        const found = new Map(rs.flatMap((r) => r.data).map((c) => [c.id, c]));
        setCards((m) => { const n = new Map(m); for (const id of ids) n.set(id, found.get(id) ?? null); return n; });   // null: no longer for sale
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [key, wishlistReady, attempt]);

  const shown = wishlist.map((id) => cards.get(id)).filter((c): c is Card => !!c);
  const loading = !wishlistReady || (missing.length > 0 && !failed);
  return (
    <div className="mx-auto w-full max-w-[1320px] px-4 py-8 md:px-6 md:py-12">
      <h1 className="font-display text-[28px] font-semibold text-ink-900 md:text-[34px]">Wishlist</h1>
      {status === 'anonymous' && wishlist.length > 0 && (
        <p className="mt-2 text-ink-700">Saved on this device. <Link href="/login?next=/wishlist" className={textLink}>Log in</Link> to keep your wishlist on every device.</p>
      )}
      <div className="mt-6">
        {failed && <FormAlert>We could not load your saved products. <button type="button" className="underline" onClick={() => { setFailed(false); setAttempt((a) => a + 1); }}>Try again</button></FormAlert>}
        {loading && shown.length === 0 && !failed && <Loading label="Loading your wishlist…" />}
        {!loading && shown.length === 0 && !failed && (
          <div className="py-12 text-center">
            <p className="text-lg font-semibold text-ink-900">Your wishlist is empty</p>
            <p className="mt-1 text-ink-700">Tap ♡ on any product to save it for later.</p>
            <Link href="/shop" className={`${primaryButton} mt-6`}>Browse products</Link>
          </div>
        )}
        {shown.length > 0 && (
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-5 xl:grid-cols-4">
            {shown.map((c) => <li key={c.id}><ProductCard card={c} /></li>)}
          </ul>
        )}
      </div>
    </div>
  );
}
