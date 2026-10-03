// Listing page frame (product.md §5.2): breadcrumb, heading (+ optional banner and description), category chips, then
// the interactive listing. Server-rendered from the URL so the first page is in the HTML (and indexable).
import type { MediaRef, ProductList } from '@artq/shared';
import Link from 'next/link';
import { loadListing, loadSearch } from '../../lib/api';
import { apiListPath, listingSearch, parseListing, type ListingFixed, type SearchParams } from '../../lib/listing';
import { Img } from '../Img';
import { ListingView } from './ListingView';

type Crumb = { name: string; href?: string };
type ListKey = 'type' | 'category' | 'technique' | 'size' | 'color' | 'thickness';

export async function ListingPage({ searchParams, fixed, title, eyebrow, description, banner, crumbs, chips, hide = [], search = false }: {
  searchParams: SearchParams; fixed: ListingFixed; title: string; eyebrow?: string; description?: string | null; banner?: MediaRef | null;
  crumbs: Crumb[]; chips?: { name: string; href: string }[]; hide?: ListKey[];
  /** Results come from /search (logged, with "Did you mean …") instead of /products. */
  search?: boolean;
}) {
  const state = parseListing(searchParams);
  const path = apiListPath(state, fixed, { pages: state.page });
  const results = search ? await loadSearch(path.replace(/^\/products\?/, '/search?')) : null;
  const list: ProductList | null = search ? results : await loadListing(path);
  return (
    <div className="mx-auto max-w-[1320px] px-4 pb-16 pt-6 md:px-6 lg:px-8">
      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-ink-700">
        <ol className="flex flex-wrap items-center gap-1">
          {[{ name: 'Home', href: '/' }, ...crumbs].map((c, i, all) => (
            <li key={c.name} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden>›</span>}
              {c.href && i < all.length - 1 ? <Link href={c.href} className="hover:text-brand-700 hover:underline">{c.name}</Link> : <span aria-current="page" className="text-ink-900">{c.name}</span>}
            </li>
          ))}
        </ol>
      </nav>
      <header className="mb-6 flex flex-col gap-4 md:flex-row md:items-center">
        {banner && <Img media={banner} alt="" sizes="96px" priority className="h-20 w-20 shrink-0 rounded-full object-cover md:h-24 md:w-24" />}
        <div>
          {eyebrow && <p className="font-eyebrow text-[13px] uppercase tracking-[0.12em] text-ink-700">{eyebrow}</p>}
          <h1 className="font-display text-[26px] font-semibold text-ink-900 md:text-4xl">{title}</h1>
          {description && <p className="mt-2 max-w-2xl text-ink-700">{description}</p>}
        </div>
      </header>
      {chips && chips.length > 0 && (
        <nav aria-label="Categories" className="-mx-4 mb-6 overflow-x-auto px-4 md:mx-0 md:px-0">
          <ul className="flex gap-2 pb-1">
            {chips.map((c) => <li key={c.href} className="shrink-0"><Link href={c.href} className="inline-flex min-h-10 items-center rounded-full border border-border-input bg-white px-4 text-sm text-ink-900 hover:border-brand-700 hover:text-brand-700">{c.name}</Link></li>)}
          </ul>
        </nav>
      )}
      {results?.suggestion && (
        <p className="mb-4 text-ink-700">Did you mean{' '}
          <Link href={`/search${listingSearch({ ...state, q: results.suggestion, page: 1 })}`} className="font-semibold text-brand-700 underline">{results.suggestion}</Link>?</p>
      )}
      <ListingView list={list} state={state} fixed={fixed} hide={hide} {...(search ? { emptyTitle: `No products match “${state.q}”` } : {})} />
    </div>
  );
}
