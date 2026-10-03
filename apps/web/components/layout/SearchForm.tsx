'use client';
// The search box with live suggestions (product.md §4.2: ≥ 2 characters, 250 ms debounce; task 3.7). WAI-ARIA combobox:
// the input owns a listbox of suggestions (products, types, categories, then "See all results"); ↓/↑ move through them
// (aria-activedescendant), Enter opens the highlighted one or searches, Esc closes the list. Same rule as the API
// (`searchForm`), shown on the field.
import { formatINR, searchForm, SUGGEST_MIN, type SearchSuggestions } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';
import { clientRequest } from '../../lib/api';
import { TextField } from '../form/fields';
import { Img } from '../Img';

type Option = { id: string; href: string; label: string; detail?: string; image?: SearchSuggestions['products'][number]['image'] };

export function SearchForm({ id = 'site-search', initial = '', onDone, autoFocus = false }: { id?: string; initial?: string; onDone?: () => void; autoFocus?: boolean }) {
  const router = useRouter();
  const listId = useId();
  const [options, setOptions] = useState<Option[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const abort = useRef<AbortController | null>(null);
  const { register, handleSubmit, control, reset, formState: { errors } } = useForm<z.input<typeof searchForm>, unknown, z.output<typeof searchForm>>({ resolver: zodResolver(searchForm), defaultValues: { q: initial } });
  const q = useWatch({ control, name: 'q' }) ?? '';
  const go = (href: string) => { setOpen(false); onDone?.(); reset({ q: '' }); router.push(href); };

  useEffect(() => {
    const term = q.trim();
    abort.current?.abort();
    if (term.length < SUGGEST_MIN) { const t = setTimeout(() => { setOptions([]); setOpen(false); }, 0); return () => clearTimeout(t); }
    const ctrl = new AbortController();
    abort.current = ctrl;
    const t = setTimeout(() => {
      clientRequest<SearchSuggestions>('GET', `/search/suggest?q=${encodeURIComponent(term)}`)
        .then((s) => {
          if (ctrl.signal.aborted) return;
          const next: Option[] = [
            ...s.products.map((p) => ({ id: `p-${p.id}`, href: `/product/${p.slug}`, label: p.name, detail: formatINR(p.fromPrice), image: p.image })),
            ...s.types.map((t) => ({ id: `t-${t.slug}`, href: t.href, label: t.name, detail: 'Product type' })),
            ...s.categories.map((c) => ({ id: `c-${c.slug}`, href: `/category/${c.slug}`, label: c.name, detail: `Category in ${c.typeName}` })),
            { id: 'all', href: `/search?q=${encodeURIComponent(term)}`, label: `See all results for “${term}”` },
          ];
          setOptions(next); setActive(-1); setOpen(true);
        })
        .catch(() => { if (!ctrl.signal.aborted) { setOptions([]); setOpen(false); } });   // suggestions are optional
    }, 250);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q]);

  const submit = handleSubmit(({ q: term }) => go(`/search?q=${encodeURIComponent(term)}`));
  const optionId = (i: number) => `${listId}-${options[i]!.id}`;
  const field = register('q');

  return (
    <form role="search" noValidate onSubmit={(e) => { if (open && active >= 0) { e.preventDefault(); go(options[active]!.href); } else void submit(e); }} className="relative flex items-start gap-2">
      <TextField id={id} label="Search products" hideLabel type="search" autoComplete="off" enterKeyHint="search" placeholder="Resin, frames, pigments…" error={errors.q?.message} className="flex-1"
        autoFocus={autoFocus} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        {...field}
        onKeyDown={(e) => {
          if (!open || options.length === 0) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % options.length); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a <= 0 ? options.length - 1 : a - 1)); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); setActive(-1); }
        }}
        onBlur={(e) => { void field.onBlur(e); setTimeout(() => setOpen(false), 150); }} />
      <button type="submit" className="mt-1 inline-flex h-12 shrink-0 items-center gap-2 rounded-md bg-brand-700 px-4 text-sm font-semibold uppercase tracking-[0.06em] text-white hover:bg-brand-800 md:h-11">
        <Search aria-hidden size={18} /><span>Search</span>
      </button>
      <p className="sr-only" aria-live="polite">{open ? `${options.length - 1} suggestions. Use the up and down arrows to choose.` : ''}</p>
      <ul id={listId} role="listbox" aria-label="Suggestions" hidden={!open}
        className="absolute inset-x-0 top-full z-10 mt-2 max-h-[60dvh] overflow-y-auto rounded-md border border-surface-200 bg-white py-1 shadow-lg">
        {options.map((o, i) => (
          <li key={o.id} id={optionId(i)} role="option" aria-selected={i === active}
            onMouseDown={(e) => e.preventDefault()} onClick={() => go(o.href)}
            className={`flex min-h-12 cursor-pointer items-center gap-3 px-3 text-sm ${i === active ? 'bg-brand-50 text-brand-800' : 'text-ink-900 hover:bg-surface-100'} ${o.id === 'all' ? 'border-t border-surface-200 font-semibold text-brand-700' : ''}`}>
            {o.image !== undefined && (o.image ? <Img media={o.image} alt="" sizes="40px" className="h-10 w-10 shrink-0 rounded object-cover" /> : <span aria-hidden className="h-10 w-10 shrink-0 rounded bg-surface-100" />)}
            <span className="flex-1">{o.label}</span>
            {o.detail && <span className="shrink-0 text-xs text-ink-700">{o.detail}</span>}
          </li>
        ))}
      </ul>
    </form>
  );
}
