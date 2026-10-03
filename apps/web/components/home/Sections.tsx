// Home page sections that need no browser code: range circles, product rows, techniques, Instagram band.
import type { HomeTechnique, HomeTypeTile, ProductCard as Card } from '@artq/shared';
import Link from 'next/link';
import { Img, ImgPlaceholder } from '../Img';
import { ProductCard } from '../product/ProductCard';
import { SectionHeading } from '../SectionHeading';

const wrap = 'mx-auto max-w-[1320px] px-4 py-10 md:px-6 md:py-[72px] lg:px-8';

export function TypeTiles({ types }: { types: HomeTypeTile[] }) {
  const tile = (key: string | number, href: string, label: string, image: HomeTypeTile['image']) => (
    <li key={key}>
      <Link href={href} className="group flex flex-col items-center gap-2 text-center">
        <span className="block h-24 w-24 overflow-hidden rounded-full bg-surface-100 ring-2 ring-transparent transition group-hover:ring-brand-700 md:h-[120px] md:w-[120px]">
          {image ? <Img media={image} alt="" sizes="120px" className="h-full w-full object-cover" /> : <ImgPlaceholder className="h-full w-full" />}
        </span>
        <span className="text-sm font-medium text-ink-900">{label}</span>
      </Link>
    </li>
  );
  return (
    <section aria-labelledby="range-heading" className={wrap}>
      <SectionHeading id="range-heading" eyebrow="Check out our range" title="Product Category" />
      <ul className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 lg:grid-cols-9">
        {types.map((t) => tile(t.id, t.href, t.name, t.image))}
        {tile('more', '/shop', 'More..', null)}
      </ul>
    </section>
  );
}

export function ProductRow({ id, title, subtitle, cards, viewAll }: { id: string; title: string; subtitle?: string; cards: Card[]; viewAll?: string }) {
  return (
    <section aria-labelledby={id} className={wrap}>
      <SectionHeading id={id} title={title} {...(subtitle ? { subtitle } : {})} />
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-5 lg:grid-cols-4 xl:grid-cols-5">
        {cards.map((c) => <li key={c.id}><ProductCard card={c} /></li>)}
      </ul>
      {viewAll && (
        <div className="mt-8 text-center">
          <Link href={viewAll} className="inline-flex h-12 items-center rounded-md border-[1.5px] border-ink-900 px-8 text-sm font-semibold uppercase tracking-[0.06em] text-ink-900 hover:bg-ink-900 hover:text-white">View all{' '}<span className="sr-only">{title}</span></Link>
        </div>
      )}
    </section>
  );
}

export function Techniques({ techniques }: { techniques: HomeTechnique[] }) {
  return (
    <section aria-labelledby="techniques-heading" className={wrap}>
      <SectionHeading id="techniques-heading" title="Shop by Technique" />
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-5 lg:grid-cols-4">
        {techniques.map((t) => (
          <li key={t.id}>
            <Link href={`/technique/${t.slug}`} className="group relative block aspect-[4/3] overflow-hidden rounded-lg bg-surface-100">
              {t.image ? <Img media={t.image} alt="" sizes="(min-width: 1024px) 25vw, 50vw" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105 motion-reduce:transition-none" /> : <ImgPlaceholder className="h-full w-full" />}
              <span aria-hidden className="absolute inset-0 bg-[linear-gradient(180deg,rgba(17,24,39,0),rgba(17,24,39,0.85))]" />
              <span className="absolute inset-x-0 bottom-0 p-3 text-[15px] font-semibold text-white">{t.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function InstagramBand({ handle, url }: { handle: string; url: string }) {
  return (
    <section aria-labelledby="instagram-heading" className="bg-brand-50">
      <div className="mx-auto flex max-w-[1320px] flex-col items-center gap-3 px-4 py-10 text-center md:px-6 lg:px-8">
        <h2 id="instagram-heading" className="font-display text-[22px] font-semibold text-ink-900 md:text-[30px]">Instagram moments</h2>
        <p className="text-ink-700">See what our makers create, and share yours with #ArtQ.</p>
        <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex h-12 items-center rounded-md bg-brand-700 px-6 text-sm font-semibold uppercase tracking-[0.06em] text-white hover:bg-brand-800">Follow @{handle}{' '}<span className="sr-only">on Instagram (opens in a new tab)</span></a>
      </div>
    </section>
  );
}
