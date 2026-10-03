'use client';
// Option picking shared by the quick-add sheet and the product page (design-system.md §5.7): Size → Colour → Thickness,
// only dimensions with a choice. A sold-out option stays selectable (crossed out, "sold out") and leads to Notify me; an
// option that does not exist with the other choices moves them to the nearest real combination (in stock first). Until
// live stock is known (or when it cannot be loaded) nothing is marked sold out.
import type { Availability, ProductDetail, PublicVariant } from '@artq/shared';
import { useState } from 'react';

export type Dim = 'size' | 'color' | 'thickness';
export const DIMS: { key: Dim; label: string }[] = [{ key: 'size', label: 'Size' }, { key: 'color', label: 'Colour' }, { key: 'thickness', label: 'Thickness' }];
export type Stock = Map<number, Availability['variants'][number]>;
type Pick = Partial<Record<Dim, string>>;

export const pickOf = (v: PublicVariant | undefined): Pick => (v ? { size: v.size ?? undefined, color: v.color ?? undefined, thickness: v.thickness ?? undefined } : {});
export const stockMap = (a: Availability): Stock => new Map(a.variants.map((v) => [v.id, v]));
/** The variant to start on: the requested one, else the cheapest in stock, else the cheapest. */
export function startVariant(product: ProductDetail, stock: Stock | null, sku?: string | null): PublicVariant | undefined {
  return product.variants.find((v) => sku && v.sku.toLowerCase() === sku.toLowerCase())
    ?? (stock ? product.variants.find((v) => (stock.get(v.id)?.maxQuantity ?? 0) > 0) : undefined)
    ?? product.variants[0];
}

export function useVariantPicker(product: ProductDetail | null, stock: Stock | null, start?: PublicVariant) {
  const [pick, setPick] = useState<Pick>(() => pickOf(start));
  const offered = product ? DIMS.filter((d) => (d.key === 'color' ? product.options.color.length : product.options[d.key].length) > 0) : [];
  const values = (d: Dim): string[] => (product ? (d === 'color' ? product.options.color.map((c) => c.name) : product.options[d]) : []);
  const hex = (value: string) => product?.options.color.find((c) => c.name === value)?.hex ?? null;
  const matches = (v: PublicVariant, sel: Pick) => offered.every((d) => sel[d.key] === undefined || v[d.key] === sel[d.key]);
  const selected = product?.variants.find((v) => matches(v, pick) && offered.every((d) => pick[d.key] !== undefined)) ?? (offered.length === 0 ? product?.variants[0] : undefined);
  const live = selected && stock ? stock.get(selected.id) : undefined;
  const max = live?.maxQuantity ?? 0;
  const inStock = (v: PublicVariant) => !stock || (stock.get(v.id)?.maxQuantity ?? 0) > 0;
  const status = (d: Dim, value: string): 'ok' | 'soldout' | 'missing' => {
    if (!product) return 'ok';
    const combos = product.variants.filter((v) => matches(v, { ...pick, [d]: value }));
    return combos.length === 0 ? 'missing' : combos.some(inStock) ? 'ok' : 'soldout';
  };
  const choose = (d: Dim, value: string): PublicVariant | undefined => {
    if (!product) return undefined;
    const next = { ...pick, [d]: value };
    if (!product.variants.some((v) => matches(v, next))) {
      const best = [...product.variants].filter((v) => v[d] === value).sort((a, b) => Number(inStock(b)) - Number(inStock(a)) || a.price - b.price)[0];
      if (best) for (const o of offered) next[o.key] = best[o.key] ?? undefined;
    }
    setPick(next);
    return product.variants.find((v) => offered.every((o) => v[o.key] === next[o.key]));
  };
  const reset = (v: PublicVariant | undefined) => setPick(pickOf(v));
  return { pick, offered, values, hex, selected, live, max, status, choose, reset };
}

export type Picker = ReturnType<typeof useVariantPicker>;

export function OptionPicker({ picker, onChoose }: { picker: Picker; onChoose?: (v: PublicVariant | undefined) => void }) {
  return (
    <>
      {picker.offered.map((d) => (
        <fieldset key={d.key}>
          <legend className="mb-2 text-[13px] font-medium text-ink-900">{d.label}{picker.pick[d.key] ? `: ${picker.pick[d.key]}` : ''}</legend>
          <div className="flex flex-wrap gap-2">
            {picker.values(d.key).map((value) => {
              const on = picker.pick[d.key] === value;
              const st = picker.status(d.key, value);
              const hex = d.key === 'color' ? picker.hex(value) : null;
              const note = st === 'soldout' ? 'sold out' : st === 'missing' ? 'other options will change' : null;
              return (
                <button key={value} type="button" aria-pressed={on} aria-label={note ? `${value}, ${note}` : undefined}
                  title={st === 'missing' ? 'Not available with your other choices; they will change' : st === 'soldout' ? 'Sold out: choose it to be told when it is back' : undefined}
                  onClick={() => onChoose?.(picker.choose(d.key, value))}
                  className={`inline-flex min-h-10 min-w-16 items-center justify-center gap-2 rounded-md px-3 text-sm ${on ? 'border-2 border-brand-700 bg-brand-50 font-semibold text-brand-800' : `border ${st === 'missing' ? 'border-dashed' : ''} border-border-input text-ink-900 hover:bg-surface-100`} ${st !== 'ok' ? 'text-ink-500' : ''} ${st === 'soldout' ? 'line-through' : ''}`}>
                  {hex && <span aria-hidden className="h-5 w-5 rounded-full border border-border-input" style={{ background: hex }} />}
                  {value}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}
    </>
  );
}
