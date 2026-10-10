'use client';
// Card actions (product.md §6): ♡ (guest wishlist) and the pill — ADD (one size in stock → straight into the cart),
// OPTIONS (several sizes → quick-add sheet), NOTIFY ME (sold out → the sheet's notify form).
import type { ProductCard } from '@artq/shared';
import { Heart } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { QuickAddSheet } from './QuickAddSheet';
import { useShop } from './ShopProvider';

export function CardActions({ card }: { card: ProductCard }) {
  const { wishlist, toggleWishlist, addToCart } = useShop();
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const pill = useRef<HTMLButtonElement>(null);
  const saved = wishlist.includes(card.id);
  const direct = card.inStock && card.variantCount === 1 && card.defaultVariantId !== null;
  const label = !card.inStock ? 'Notify me' : direct ? 'Add' : 'Options';
  // The full name starts with the visible word (WCAG 2.5.3) and says what it acts on.
  const fullName = !card.inStock ? `Notify me about ${card.name}` : direct ? `Add ${card.name} to cart` : `Options for ${card.name}`;

  const onPill = async () => {
    if (!direct) { setSheet(true); return; }
    setBusy(true);
    const r = await addToCart(card.defaultVariantId!, 1, card.name, { returnFocus: pill.current });
    setBusy(false);
    if (!r.ok) {
      if (r.code === 'OUT_OF_STOCK') setSheet(true);   // sold out meanwhile: offer "Notify me"
      else toast(r.message);
    }
  };

  return (
    <>
      <button type="button" aria-pressed={saved} onClick={() => { const on = toggleWishlist(card.id); toast(on ? `Saved ${card.name} to your wishlist` : `Removed ${card.name} from your wishlist`); }}
        className="absolute right-1 top-1 z-10 flex h-11 w-11 items-center justify-center rounded-full text-ink-900">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/90 shadow-sm"><Heart aria-hidden size={18} className={saved ? 'fill-danger-700 text-danger-700' : ''} /></span>
        <span className="sr-only">{saved ? `Remove ${card.name} from wishlist` : `Save ${card.name} to wishlist`}</span>
      </button>
      <button ref={pill} type="button" onClick={() => void onPill()} disabled={busy} aria-busy={busy || undefined} aria-haspopup={direct ? undefined : 'dialog'} aria-label={busy ? `Adding ${card.name}` : fullName}
        className={`relative z-10 mt-2 inline-flex h-11 items-center justify-center self-start rounded-full px-5 text-[13px] font-semibold uppercase tracking-[0.06em] ${card.inStock ? 'bg-brand-700 text-white hover:bg-brand-800' : 'border-[1.5px] border-ink-900 text-ink-900 hover:bg-ink-900 hover:text-white'} disabled:bg-surface-100 disabled:text-ink-500`}>
        {busy ? 'Adding…' : label}
      </button>
      {sheet && <QuickAddSheet slug={card.slug} name={card.name} open={sheet} onOpenChange={setSheet} onClosed={() => pill.current?.focus()} returnFocus={() => pill.current} />}
    </>
  );
}
