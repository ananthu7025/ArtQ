import { describe, expect, it } from 'vitest';
import { canonicalJson, requestHash } from '../src/idempotency/idempotency.js';

describe('canonicalJson', () => {
  it.each([
    [{ b: 1, a: 2 }, '{"a":2,"b":1}'],
    [{ z: { y: 1, x: [3, { d: 1, c: 2 }] } }, '{"z":{"x":[3,{"c":2,"d":1}],"y":1}}'],
    [{ a: undefined, b: null }, '{"b":null}'],
    [[1, undefined, 'x'], '[1,null,"x"]'],
    ['é ₹ "q"', '"é ₹ \\"q\\""'],
    [0, '0'], [true, 'true'], [null, 'null'], [{}, '{}'], [[], '[]'],
  ])('%j → %s', (v, out) => { expect(canonicalJson(v)).toBe(out); });

  it('key order never matters; array order does', () => {
    expect(canonicalJson({ a: 1, b: { c: 1, d: 2 } })).toBe(canonicalJson({ b: { d: 2, c: 1 }, a: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('rejects values JSON cannot represent faithfully', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
  });
});

describe('requestHash (api.md §1.2)', () => {
  const base = { operation: 'checkout.initiate', target: 'cart:1', scope: 'user:7', body: { couponCode: 'SAVE', paymentMethod: 'COD' } };
  it('is a SHA-256 hex digest, stable across key order', () => {
    expect(requestHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(requestHash({ ...base, body: { paymentMethod: 'COD', couponCode: 'SAVE' } })).toBe(requestHash(base));
  });
  it.each([
    ['operation', { operation: 'payment.retry' }],
    ['target (same body, different order: never a replay of the first)', { target: 'cart:2' }],
    ['scope', { scope: 'user:8' }],
    ['body', { body: { couponCode: 'SAVE', paymentMethod: 'RAZORPAY' } }],
  ])('changes with the %s', (_d, over) => {
    expect(requestHash({ ...base, ...over })).not.toBe(requestHash(base));
  });
});
