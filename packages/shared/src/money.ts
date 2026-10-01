// All money is integer paise (database.md §1). Rounding happens once, per line, with exact integer arithmetic.
export type Paise = number;

/** Throws unless `v` is a non-negative safe integer (a valid paise amount or count). */
export function assertNonNegativeInt(v: number, name = 'value'): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative integer, got ${v}`);
}

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

/** round_half_up(a / b) for non-negative integers, exact (no floating point). */
export function divRoundHalfUp(a: number, b: number): number {
  assertNonNegativeInt(a, 'dividend');
  if (!Number.isSafeInteger(b) || b <= 0) throw new RangeError(`divisor must be a positive integer, got ${b}`);
  return Math.floor((2 * a + b) / (2 * b));
}

/** ceil(a / b) for non-negative integers, exact. */
export function divCeil(a: number, b: number): number {
  assertNonNegativeInt(a, 'dividend');
  if (!Number.isSafeInteger(b) || b <= 0) throw new RangeError(`divisor must be a positive integer, got ${b}`);
  return Math.floor((a + b - 1) / b);
}

/** product.md §8.1: round((MRP − price) / MRP × 100); null when there is no discount. */
export function discountPercent(price: Paise, mrp: Paise | null): number | null {
  if (mrp === null || mrp <= price) return null;
  return divRoundHalfUp((mrp - price) * 100, mrp);
}

/**
 * Splits `total` across `weights` pro rata using the largest-remainder method: each share is floor(total × w / Σw),
 * and the leftover paise go one each to the largest fractional remainders (ties: earlier index first).
 * Shares always sum to `total`, and no share exceeds its weight when total ≤ Σw.
 */
export function allocateLargestRemainder(total: Paise, weights: readonly number[]): Paise[] {
  assertNonNegativeInt(total, 'total');
  weights.forEach((w, i) => assertNonNegativeInt(w, `weights[${i}]`));
  const sum = weights.reduce((s, w) => s + w, 0);
  if (total === 0) return weights.map(() => 0);
  if (sum === 0) throw new RangeError('cannot allocate a non-zero total over zero weights');
  const shares = weights.map((w) => Math.floor((total * w) / sum));
  const order = weights
    .map((w, i) => ({ i, rem: (total * w) % sum }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  let left = total - shares.reduce((s, x) => s + x, 0);
  for (const { i } of order) {
    if (left === 0) break;
    shares[i]! += 1;
    left -= 1;
  }
  return shares;
}
