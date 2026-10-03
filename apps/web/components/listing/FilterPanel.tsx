'use client';
// Listing filters (product.md §5.2): type, category, technique, size, colour, thickness (checkboxes with counts that
// already apply every other filter), price range (whole rupees, the shared rule), in stock, on sale. Every change applies
// at once through the URL. Long lists show the first 8 with "Show all".
import { formatINR, priceRangeForm, type Facet, type ProductList } from '@artq/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import type { ListingState } from '../../lib/listing';
import { TextField } from '../form/fields';

type ListKey = 'type' | 'category' | 'technique' | 'size' | 'color' | 'thickness';
export const GROUPS: { key: ListKey; facet: keyof Omit<ProductList['facets'], 'price'>; label: string }[] = [
  { key: 'type', facet: 'types', label: 'Product type' }, { key: 'category', facet: 'categories', label: 'Category' }, { key: 'technique', facet: 'techniques', label: 'Technique' },
  { key: 'size', facet: 'sizes', label: 'Size' }, { key: 'color', facet: 'colors', label: 'Colour' }, { key: 'thickness', facet: 'thicknesses', label: 'Thickness' },
];
const SHOWN = 8;

function Group({ id, label, facets, chosen, onToggle }: { id: string; label: string; facets: Facet[]; chosen: string[]; onToggle: (value: string) => void }) {
  const [all, setAll] = useState(false);
  const visible = all ? facets : facets.slice(0, SHOWN);
  return (
    <fieldset className="border-t border-surface-200 py-4">
      <legend className="float-left mb-2 w-full text-sm font-semibold text-ink-900">{label}</legend>
      <ul id={id} className="clear-both space-y-1">
        {visible.map((f) => {
          const on = chosen.includes(f.value);
          return (
            <li key={f.value}>
              <label className="flex min-h-9 cursor-pointer items-center gap-3 text-sm text-ink-700">
                <input type="checkbox" className="h-4 w-4 shrink-0 accent-brand-700" checked={on} onChange={() => onToggle(f.value)} aria-label={`${f.label}, ${f.count} ${f.count === 1 ? 'product' : 'products'}`} />
                {f.hex && <span aria-hidden className="h-4 w-4 shrink-0 rounded-full border border-border-input" style={{ background: f.hex }} />}
                <span className="flex-1">{f.label}</span>
                <span aria-hidden className="tabular-nums text-ink-500">{f.count}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {facets.length > SHOWN && (
        <button type="button" aria-expanded={all} aria-controls={id} onClick={() => setAll((a) => !a)} className="mt-1 min-h-9 text-sm font-medium text-brand-700 underline">
          {all ? 'Show fewer' : `Show all ${facets.length}`}<span className="sr-only"> {label.toLowerCase()} options</span>
        </button>
      )}
    </fieldset>
  );
}

function PriceForm({ state, range, onApply }: { state: ListingState; range: ProductList['facets']['price']; onApply: (min: number | null, max: number | null) => void }) {
  const ids = useId();
  type In = z.input<typeof priceRangeForm>; type Out = z.output<typeof priceRangeForm>;
  const { register, handleSubmit, formState: { errors } } = useForm<In, unknown, Out>({
    resolver: zodResolver(priceRangeForm), values: { min: state.min === null ? '' : String(state.min), max: state.max === null ? '' : String(state.max) },
  });
  const submit = handleSubmit(({ min, max }) => onApply(min === '' ? null : min, max === '' ? null : max));
  return (
    <form noValidate onSubmit={(e) => { void submit(e); }} className="border-t border-surface-200 py-4" aria-labelledby={`${ids}-price`}>
      <p id={`${ids}-price`} className="mb-2 text-sm font-semibold text-ink-900">Price (₹)</p>
      {range && <p className="mb-2 text-xs text-ink-700">From {formatINR(range.min)} to {formatINR(range.max)}</p>}
      <div className="grid grid-cols-2 gap-3">
        <TextField id={`${ids}-min`} label="Minimum" inputMode="numeric" placeholder={range ? String(Math.floor(range.min / 100)) : '0'} error={errors.min?.message} {...register('min')} />
        <TextField id={`${ids}-max`} label="Maximum" inputMode="numeric" placeholder={range ? String(Math.ceil(range.max / 100)) : ''} error={errors.max?.message} {...register('max')} />
      </div>
      <button type="submit" className="mt-3 h-11 w-full rounded-md border-[1.5px] border-ink-900 text-sm font-semibold uppercase tracking-[0.06em] text-ink-900 hover:bg-ink-900 hover:text-white">Apply price</button>
    </form>
  );
}

export function FilterPanel({ list, state, hide, onChange }: { list: ProductList; state: ListingState; hide: ListKey[]; onChange: (next: ListingState) => void }) {
  const id = useId();
  const toggle = (key: ListKey, value: string) => {
    const cur = state[key];
    onChange({ ...state, [key]: cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value], page: 1 });
  };
  return (
    <div>
      {GROUPS.filter((g) => !hide.includes(g.key) && list.facets[g.facet].length > 0).map((g) => (
        <Group key={g.key} id={`${id}-${g.key}`} label={g.label} facets={list.facets[g.facet]} chosen={state[g.key]} onToggle={(v) => toggle(g.key, v)} />
      ))}
      <PriceForm state={state} range={list.facets.price} onApply={(min, max) => onChange({ ...state, min, max, page: 1 })} />
      <fieldset className="border-t border-surface-200 py-4">
        <legend className="mb-2 text-sm font-semibold text-ink-900">Availability</legend>
        {([['inStock', 'In stock only'], ['sale', 'On sale']] as const).map(([k, label]) => (
          <label key={k} className="flex min-h-9 cursor-pointer items-center gap-3 text-sm text-ink-700">
            <input type="checkbox" className="h-4 w-4 accent-brand-700" checked={state[k]} onChange={() => onChange({ ...state, [k]: !state[k], page: 1 })} />{label}
          </label>
        ))}
      </fieldset>
    </div>
  );
}
