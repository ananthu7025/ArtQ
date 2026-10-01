// All money is integer paise (database.md §1). Rounding happens once, per line.
export type Paise = number;

export function toPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) throw new RangeError('rupees must be finite');
  return Math.round(rupees * 100);
}

export function formatINR(paise: Paise): string {
  if (!Number.isInteger(paise)) throw new RangeError('paise must be an integer');
  const whole = paise % 100 === 0;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR',
    minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2,
  }).format(paise / 100);
}

export function discountPercent(price: Paise, mrp: Paise | null): number | null {
  if (mrp === null || mrp <= price) return null;
  return Math.round(((mrp - price) / mrp) * 100);
}
