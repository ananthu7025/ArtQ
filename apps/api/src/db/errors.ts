// Maps exceptions raised by the database functions/triggers (migrations 0002/0003) to typed errors.
// Prisma surfaces a raw-query exception as P2010 with meta { code: SQLSTATE, message: 'ERROR: CODE:detail' };
// trigger failures during ORM writes arrive as other Prisma errors carrying the same text in `message`.

/** Business error codes raised by the `aq_*` functions and 0002 triggers. */
export const DB_ERROR_CODES = [
  'OUT_OF_STOCK',
  'COUPON_INVALID',
  'COUPON_USAGE_EXCEEDED',
  'REFUND_EXCEEDS_CAPACITY',
  'REFUND_RECONCILIATION_REQUIRED',
  'REFUND_PAYMENT_INVALID',
  'REFUND_AMOUNT_INVALID',
  'REFUND_NOT_RETRYABLE',
  'REFUND_NOT_CANCELLABLE',
  'IDEMPOTENCY_OWNERSHIP_LOST',
  'LEASE_LOST',
  'NOT_FOUND',
  'INVALID_ADJUSTMENT',
  'STOCK_ALREADY_SET',
  'NOT_PUBLISHABLE',
  'INVARIANT',
] as const;
export type DbErrorCode = (typeof DB_ERROR_CODES)[number];

export class DbFunctionError extends Error {
  constructor(
    readonly code: DbErrorCode,
    /** Text after `CODE:` (e.g. the variant id for OUT_OF_STOCK, `customer`/`total` for COUPON_USAGE_EXCEEDED). */
    readonly detail: string | undefined,
    readonly sqlState: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(detail ? `${code}:${detail}` : code, options);
    this.name = 'DbFunctionError';
  }
}

const PATTERN = new RegExp(`\\b(${DB_ERROR_CODES.join('|')})(?![A-Z_])(?::\\s*([^\`\\n]+))?`);

/** Returns a DbFunctionError when `e` carries one of the known codes, otherwise undefined. */
export function parseDbError(e: unknown): DbFunctionError | undefined {
  if (!(e instanceof Error)) return undefined;
  const meta = (e as { meta?: { code?: unknown; message?: unknown } }).meta;
  const text = typeof meta?.message === 'string' ? meta.message : e.message;
  const m = PATTERN.exec(text);
  if (!m) return undefined;
  return new DbFunctionError(m[1] as DbErrorCode, m[2]?.trim() || undefined,typeof meta?.code === 'string' ? meta.code : undefined, { cause: e });
}

/** Rethrows `e` as a DbFunctionError when it is one, unchanged otherwise. */
export function rethrowDbError(e: unknown): never {
  throw parseDbError(e) ?? e;
}
