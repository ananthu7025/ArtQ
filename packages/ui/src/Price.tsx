import { discountPercent, formatINR } from '@artq/shared';

/** Selling price with optional struck MRP and discount (design-system.md §5.5). Amounts are integer paise. */
export function Price({ price, mrp = null, from = false }: { price: number; mrp?: number | null; from?: boolean }) {
  if (!Number.isInteger(price) || price < 0) throw new RangeError('price must be a non-negative integer (paise)');
  if (mrp !== null && (!Number.isInteger(mrp) || mrp < 0)) throw new RangeError('mrp must be a non-negative integer (paise)');
  const pct = discountPercent(price, mrp);
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'baseline', fontFamily: 'var(--font-body)' }}>
      <span style={{ fontWeight: 600, color: 'var(--ink-900)' }}>{from ? 'From ' : ''}{formatINR(price)}</span>
      {pct !== null && mrp !== null && (
        <>
          <s style={{ color: 'var(--ink-500)', fontSize: '0.85em' }}><span style={visuallyHidden}>MRP </span>{formatINR(mrp)}</s>
          <span style={{ color: 'var(--brand-700)', fontWeight: 600, fontSize: '0.85em' }}>{pct}% OFF</span>
        </>
      )}
    </span>
  );
}

const visuallyHidden = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' } as const;
