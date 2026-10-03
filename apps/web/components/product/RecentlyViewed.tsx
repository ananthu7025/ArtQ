'use client';
// Recently viewed (product.md §5.3): kept in this browser (newest first, 12 at most, never the product on screen),
// shown as cards loaded by id. Records the current product after showing the others.
import type { ProductCard as Card } from '@artq/shared';
import { useEffect, useState } from 'react';
import { clientRequest } from '../../lib/api';
import { SectionHeading } from '../SectionHeading';
import { ProductCard } from './ProductCard';

export const RECENT_KEY = 'aq_recent';
const MAX = 12;
function read(): number[] {
  try { const v: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is number => Number.isSafeInteger(x) && x > 0).slice(0, MAX) : []; } catch { return []; }
}

export function RecentlyViewed({ productId }: { productId: number }) {
  const [cards, setCards] = useState<Card[]>([]);
  useEffect(() => {
    const before = read();
    const others = before.filter((id) => id !== productId).slice(0, 8);
    try { window.localStorage.setItem(RECENT_KEY, JSON.stringify([productId, ...before.filter((id) => id !== productId)].slice(0, MAX))); } catch { /* storage blocked */ }
    if (others.length === 0) return;
    let live = true;
    clientRequest<{ data: Card[] }>('GET', `/products/by-ids?ids=${others.join(',')}`).then((r) => { if (live) setCards(r.data); }).catch(() => { /* optional section */ });
    return () => { live = false; };
  }, [productId]);
  if (cards.length === 0) return null;
  return (
    <section aria-labelledby="recent-heading" className="mx-auto max-w-[1320px] px-4 py-10 md:px-6 lg:px-8">
      <SectionHeading id="recent-heading" title="Recently viewed" />
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-5 lg:grid-cols-4">{cards.map((c) => <li key={c.id}><ProductCard card={c} /></li>)}</ul>
    </section>
  );
}
