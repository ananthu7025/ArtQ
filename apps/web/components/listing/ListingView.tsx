'use client';
// The listing body (product.md §5.2): result count, sort, filters (sidebar ≥ 1024 px, bottom sheet below), active-filter
// chips, the grid, "Load more" (keeps ?page= in the address so a reload or a shared link shows as much), skeletons
// while a new filter loads, and an empty state. The URL is the state: every change navigates to the new query.
import { LISTING_PAGE_SIZE, LISTING_SORTS, type ProductCard as Card, type ProductList } from '@artq/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { SlidersHorizontal, X } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useOptimistic, useState, useTransition } from 'react';
import { clientRequest } from '../../lib/api';
import { activeCount, apiListPath, EMPTY_STATE, listingSearch, SORT_LABELS, type ListingFixed, type ListingState } from '../../lib/listing';
import { FormAlert } from '../form/fields';
import { ProductCard } from '../product/ProductCard';
import { FilterPanel, GROUPS } from './FilterPanel';

type ListKey = 'type' | 'category' | 'technique' | 'size' | 'color' | 'thickness';

function Skeletons() {
  return (
    <ul aria-hidden className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-5 xl:grid-cols-4">
      {Array.from({ length: 8 }, (_, i) => (
        <li key={i}><div className="aspect-square rounded-lg bg-surface-100 motion-safe:animate-pulse" /><div className="mt-3 h-4 w-3/4 rounded bg-surface-100" /><div className="mt-2 h-4 w-1/3 rounded bg-surface-100" /></li>
      ))}
    </ul>
  );
}

export function ListingView({ list, state: current, fixed, hide }: { list: ProductList | null; state: ListingState; fixed: ListingFixed; hide: ListKey[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  // The shopper's choice shows at once (ticked box, chip, sort) while the new results load.
  const [state, setOptimistic] = useOptimistic(current);
  const [sheet, setSheet] = useState(false);
  const key = listingSearch({ ...current, page: 1 });
  const [more, setMore] = useState<{ key: string; cards: Card[]; page: number } | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const go = (next: ListingState) => { setMoreError(null); startTransition(() => { setOptimistic({ ...next, page: 1 }); router.push(`${pathname}${listingSearch({ ...next, page: 1 })}`, { scroll: false }); }); };

  if (!list) {
    return (
      <div className="py-16 text-center">
        <FormAlert>We couldn’t load products right now. Please try again in a moment.</FormAlert>
        <button type="button" onClick={() => router.refresh()} className="mt-4 h-11 rounded-md bg-brand-700 px-6 text-sm font-semibold uppercase tracking-[0.06em] text-white hover:bg-brand-800">Try again</button>
      </div>
    );
  }

  const extra = more?.key === key ? more : null;
  const cards = [...list.data, ...(extra?.cards ?? [])];
  const page = extra?.page ?? Math.max(1, Math.ceil(list.data.length / LISTING_PAGE_SIZE));
  const hasMore = cards.length < list.meta.total;
  const chosen = activeCount(state);
  const label = (k: ListKey, v: string) => list.facets[GROUPS.find((g) => g.key === k)!.facet].find((f) => f.value === v)?.label ?? v;

  const loadMore = async () => {
    setMoreBusy(true); setMoreError(null);
    try {
      const next = await clientRequest<ProductList>('GET', apiListPath(current, fixed, { page: page + 1 }));
      setMore({ key, cards: [...(extra?.cards ?? []), ...next.data], page: page + 1 });
      window.history.replaceState(null, '', `${pathname}${listingSearch({ ...current, page: page + 1 })}`);
    } catch {
      setMoreError('We couldn’t load more products. Please try again.');
    } finally { setMoreBusy(false); }
  };

  const chips: { text: string; remove: ListingState }[] = [
    ...(['type', 'category', 'technique', 'size', 'color', 'thickness'] as const).filter((k) => !hide.includes(k)).flatMap((k) => state[k].map((v) => ({ text: label(k, v), remove: { ...state, [k]: state[k].filter((x) => x !== v) } }))),
    ...(state.min !== null || state.max !== null ? [{ text: `₹${state.min ?? 0} – ${state.max !== null ? `₹${state.max}` : 'any'}`, remove: { ...state, min: null, max: null } }] : []),
    ...(state.inStock ? [{ text: 'In stock', remove: { ...state, inStock: false } }] : []),
    ...(state.sale ? [{ text: 'On sale', remove: { ...state, sale: false } }] : []),
  ];
  const panel = <FilterPanel list={list} state={state} hide={hide} onChange={go} />;
  const sorts = LISTING_SORTS.filter((s) => s !== 'relevance' || state.q);

  return (
    <div className="lg:grid lg:grid-cols-[260px_1fr] lg:gap-8">
      <aside aria-label="Filters" className="hidden lg:sticky lg:top-24 lg:block lg:max-h-[calc(100dvh-7rem)] lg:self-start lg:overflow-y-auto">
        <h2 className="pb-2 text-sm font-semibold uppercase tracking-[0.12em] text-ink-900">Filters</h2>
        {panel}
      </aside>
      <div>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p role="status" className="text-sm text-ink-700">{list.meta.total === 1 ? '1 product' : `${list.meta.total} products`}</p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setSheet(true)} aria-label={chosen > 0 ? `Filters, ${chosen} chosen` : 'Filters'} className="inline-flex h-11 items-center gap-2 rounded-md border border-border-input px-4 text-sm font-medium text-ink-900 lg:hidden">
              <SlidersHorizontal aria-hidden size={16} />Filters{chosen > 0 && <span aria-hidden className="rounded-full bg-brand-700 px-2 text-xs font-semibold text-white">{chosen}</span>}
            </button>
            <label className="flex items-center gap-2 text-sm text-ink-900">
              <span className="sr-only md:not-sr-only">Sort by</span>
              <select value={state.sort ?? (state.q ? 'relevance' : 'featured')} onChange={(e) => go({ ...state, sort: e.target.value as ListingState['sort'] })}
                className="h-11 rounded-md border border-border-input bg-white px-3 text-base text-ink-900 md:text-sm">
                {sorts.map((s) => <option key={s} value={s}>{SORT_LABELS[s]}</option>)}
              </select>
            </label>
          </div>
        </div>
        {chips.length > 0 && (
          <ul aria-label="Active filters" className="mb-4 flex flex-wrap gap-2">
            {chips.map((c) => (
              <li key={c.text}>
                <button type="button" onClick={() => go(c.remove)} className="inline-flex min-h-9 items-center gap-1 rounded-full border border-brand-700 bg-brand-50 px-3 text-sm text-brand-800 hover:bg-white">
                  {c.text}<X aria-hidden size={14} /><span className="sr-only">, remove this filter</span>
                </button>
              </li>
            ))}
            <li><button type="button" onClick={() => go({ ...EMPTY_STATE, q: state.q, sort: state.sort })} className="min-h-9 px-2 text-sm font-medium text-brand-700 underline">Clear all</button></li>
          </ul>
        )}
        <div aria-busy={pending || undefined}>
          {pending ? <Skeletons /> : list.meta.total === 0 ? (
            <div className="rounded-lg border border-surface-200 bg-white px-6 py-12 text-center">
              <p className="font-display text-xl font-semibold text-ink-900">No products match {chosen > 0 ? 'these filters' : 'here yet'}</p>
              <p className="mt-2 text-sm text-ink-700">{chosen > 0 ? 'Try removing a filter or two.' : 'New products are on their way. Have a look at everything else meanwhile.'}</p>
              {chosen > 0 && <button type="button" onClick={() => go({ ...EMPTY_STATE, q: state.q })} className="mt-6 h-11 rounded-md bg-brand-700 px-6 text-sm font-semibold uppercase tracking-[0.06em] text-white hover:bg-brand-800">Clear filters</button>}
            </div>
          ) : (
            <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-5 xl:grid-cols-4">
              {cards.map((c) => <li key={c.id}><ProductCard card={c} /></li>)}
            </ul>
          )}
        </div>
        {!pending && hasMore && (
          <div className="mt-8 flex flex-col items-center gap-2">
            <p className="text-sm text-ink-700">Showing {cards.length} of {list.meta.total}</p>
            {moreError && <FormAlert>{moreError}</FormAlert>}
            <button type="button" onClick={() => void loadMore()} disabled={moreBusy} aria-busy={moreBusy || undefined}
              className="h-12 rounded-md border-[1.5px] border-ink-900 px-8 text-sm font-semibold uppercase tracking-[0.06em] text-ink-900 hover:bg-ink-900 hover:text-white disabled:border-surface-200 disabled:bg-surface-100 disabled:text-ink-500">
              {moreBusy ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
      <Dialog.Root open={sheet} onOpenChange={setSheet}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-900/50" />
          <Dialog.Content aria-describedby={undefined} className="fixed inset-x-0 bottom-0 z-[60] flex max-h-[85dvh] flex-col rounded-t-xl bg-white focus:outline-none">
            <div className="flex items-center justify-between border-b border-surface-200 px-5 py-3">
              <Dialog.Title className="font-display text-lg font-semibold text-ink-900">Filters</Dialog.Title>
              <Dialog.Close className="inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-surface-100" aria-label="Close filters"><X aria-hidden size={22} /></Dialog.Close>
            </div>
            <div className="flex-1 overflow-y-auto px-5">{panel}</div>
            <div className="border-t border-surface-200 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
              <Dialog.Close className="h-12 w-full rounded-md bg-brand-700 text-sm font-semibold uppercase tracking-[0.06em] text-white hover:bg-brand-800">
                {pending ? 'Updating…' : `Show ${list.meta.total === 1 ? '1 product' : `${list.meta.total} products`}`}
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
