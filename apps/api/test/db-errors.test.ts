import { describe, expect, it } from 'vitest';
import { DbFunctionError, parseDbError, rethrowDbError } from '../src/db/errors.js';

/** Shape of a Prisma P2010 raw-query error (verified against Prisma 6.19.3 + PostgreSQL 16). */
const prismaRaw = (sqlState: string, text: string) =>
  Object.assign(new Error(`Invalid \`prisma.$queryRaw()\` invocation:\n\nRaw query failed. Code: \`${sqlState}\`. Message: \`ERROR: ${text}\``), {
    code: 'P2010', meta: { code: sqlState, message: `ERROR: ${text}` },
  });

describe('parseDbError', () => {
  it.each([
    ['P0001', 'OUT_OF_STOCK:42', 'OUT_OF_STOCK', '42'],
    ['P0001', 'COUPON_INVALID', 'COUPON_INVALID', undefined],
    ['P0001', 'COUPON_USAGE_EXCEEDED:customer', 'COUPON_USAGE_EXCEEDED', 'customer'],
    ['P0001', 'REFUND_EXCEEDS_CAPACITY:item:17', 'REFUND_EXCEEDS_CAPACITY', 'item:17'],
    ['P0001', 'REFUND_RECONCILIATION_REQUIRED:payment', 'REFUND_RECONCILIATION_REQUIRED', 'payment'],
    ['P0003', 'IDEMPOTENCY_OWNERSHIP_LOST:key-1', 'IDEMPOTENCY_OWNERSHIP_LOST', 'key-1'],
    ['P0002', 'LEASE_LOST:webhook:9', 'LEASE_LOST', 'webhook:9'],
    ['P0001', 'NOT_FOUND:variant:999', 'NOT_FOUND', 'variant:999'],
    ['23514', 'NOT_PUBLISHABLE: no_image,no_hsn', 'NOT_PUBLISHABLE', 'no_image,no_hsn'],
    ['P0001', 'INVARIANT: order 5 could not transition to PLACED', 'INVARIANT', 'order 5 could not transition to PLACED'],
  ])('%s %s → %s', (state, text, code, detail) => {
    const e = parseDbError(prismaRaw(state, text));
    expect(e).toBeInstanceOf(DbFunctionError);
    expect(e).toMatchObject({ code, detail, sqlState: state, name: 'DbFunctionError' });
    expect(e!.message).toBe(detail ? `${code}:${detail}` : code);
    expect(e!.cause).toBeInstanceOf(Error);
  });

  it('reads the message of non-raw Prisma errors (trigger failure during an ORM write)', () => {
    const e = parseDbError(new Error('Error occurred during query execution: db error: ERROR: NOT_PUBLISHABLE: no_image'));
    expect(e).toMatchObject({ code: 'NOT_PUBLISHABLE', detail: 'no_image', sqlState: undefined });
  });

  it.each([
    ['unrelated database error', prismaRaw('23505', 'duplicate key value violates unique constraint "users_email_key"')],
    ['plain error', new Error('boom')],
    ['partial code match', prismaRaw('P0001', 'MY_OUT_OF_STOCKS')],
  ])('returns undefined for %s', (_n, err) => {
    expect(parseDbError(err)).toBeUndefined();
  });

  it.each([null, undefined, 'OUT_OF_STOCK:1', { message: 'OUT_OF_STOCK:1' }])('returns undefined for non-Error %j', (v) => {
    expect(parseDbError(v)).toBeUndefined();
  });

  it('rethrowDbError maps known errors and rethrows others unchanged', () => {
    expect(() => rethrowDbError(prismaRaw('P0001', 'COUPON_INVALID'))).toThrow(DbFunctionError);
    const other = new Error('connection reset');
    expect(() => rethrowDbError(other)).toThrow(other);
  });
});
