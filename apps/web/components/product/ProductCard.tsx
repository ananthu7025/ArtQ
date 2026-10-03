// Product card (product.md §6, design-system.md §5.5): fixed 1:1 image box (placeholder when there is no photo; second
// photo on hover), badges, ♡, name (2 lines), "From ₹…" / "₹…", struck MRP, and the ADD / OPTIONS / NOTIFY ME pill.
import { formatINR, type ProductCard as Card } from '@artq/shared';
import Link from 'next/link';
import { Img, ImgPlaceholder } from '../Img';
import { CardActions } from '../shop/CardActions';

export const CARD_SIZES = '(min-width: 1280px) 240px, (min-width: 768px) 30vw, 46vw';

export function ProductCard({ card }: { card: Card }) {
  const ranged = card.maxPrice > card.fromPrice;
  return (
    <article className="group relative flex flex-col">
      <div className="relative aspect-square overflow-hidden rounded-lg bg-surface-100">
        {card.image
          ? (
            <>
              <Img media={card.image} sizes={CARD_SIZES} className="h-full w-full object-cover transition-opacity duration-300" />
              {card.hoverImage && <Img media={card.hoverImage} alt="" sizes={CARD_SIZES} className="absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-300 group-hover:opacity-100 motion-reduce:transition-none" />}
            </>
          )
          : <ImgPlaceholder label={`${card.name}: no photo yet`} className="h-full w-full" />}
        <div className="absolute left-2 top-2 flex flex-col items-start gap-1">
          {card.isNew && <span className="rounded-sm bg-ink-900 px-2 py-1 text-[11px] font-semibold uppercase leading-none text-white">New</span>}
          {card.discountPercent !== null && <span className="rounded-sm bg-brand-700 px-2 py-1 text-[11px] font-semibold uppercase leading-none text-white">−{card.discountPercent}%</span>}
          {!card.inStock && <span className="rounded-sm bg-surface-200 px-2 py-1 text-[11px] font-semibold uppercase leading-none text-ink-700">Out of stock</span>}
        </div>
      </div>
      <h3 className="mt-3 line-clamp-2 text-[15px] font-medium leading-snug text-ink-900">
        <Link href={`/product/${card.slug}`} className="after:absolute after:inset-0 after:content-[''] hover:text-brand-700">{card.name}</Link>
      </h3>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-base">
        <span className="font-semibold text-ink-900">{ranged ? `From ${formatINR(card.fromPrice)}` : formatINR(card.fromPrice)}</span>
        {card.mrp !== null && <s className="text-sm text-ink-500"><span className="sr-only">MRP </span>{formatINR(card.mrp)}</s>}
      </p>
      <CardActions card={card} />
    </article>
  );
}
