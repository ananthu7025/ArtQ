import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hmacHexMatches, NotImplementedYetError, RAZORPAY_EVENTS, razorpayProvider } from '../src/webhooks/provider.js';

const SECRET = 'whsec_test_123';
const sign = (body: string, secret = SECRET) => createHmac('sha256', secret).update(body).digest('hex');

describe('hmacHexMatches', () => {
  const body = Buffer.from('{"event":"payment.captured"}');
  it('accepts the right signature (any hex case) and rejects everything else', () => {
    expect(hmacHexMatches(SECRET, body, sign(body.toString()))).toBe(true);
    expect(hmacHexMatches(SECRET, body, sign(body.toString()).toUpperCase())).toBe(true);
    expect(hmacHexMatches(SECRET, body, sign(body.toString(), 'other'))).toBe(false);
    expect(hmacHexMatches(SECRET, Buffer.from('{"event":"payment.captured" }'), sign(body.toString()))).toBe(false);   // one byte differs
    expect(hmacHexMatches(SECRET, body, undefined)).toBe(false);
    expect(hmacHexMatches(SECRET, body, 'zz')).toBe(false);
    expect(hmacHexMatches(SECRET, body, sign(body.toString()).slice(0, 63))).toBe(false);
  });
});

describe('razorpayProvider', () => {
  it('verifies X-Razorpay-Signature over the raw body; event id from the header; type and time from the body', () => {
    const p = razorpayProvider(SECRET);
    const raw = '{"event":"payment.captured","created_at":1790000000}';
    expect(p.verify!(Buffer.from(raw), { 'x-razorpay-signature': sign(raw) })).toBe(true);
    expect(p.verify!(Buffer.from(raw), { 'x-razorpay-signature': sign(raw, 'x') })).toBe(false);
    expect(p.verify!(Buffer.from(raw), {})).toBe(false);
    expect(p.eventId({ 'x-razorpay-event-id': 'evt_1' }, {})).toBe('evt_1');
    expect(p.eventId({}, {})).toBeNull();
    expect(p.eventType(JSON.parse(raw))).toBe('payment.captured');
    expect(p.eventType({})).toBeNull();
    expect(p.eventType('nope')).toBeNull();
    expect(p.createdAt(JSON.parse(raw))).toEqual(new Date(1_790_000_000_000));
    expect(p.createdAt({})).toBeNull();
    expect(p).toMatchObject({ slug: 'razorpay', name: 'RAZORPAY' });
  });

  it('without a secret the receiver is "not configured" (verify is null)', () => {
    expect(razorpayProvider(undefined).verify).toBeNull();
  });

  it('handles exactly the api.md §5 events; until Phase 4 their handlers fail loudly', async () => {
    const p = razorpayProvider(SECRET);
    expect(Object.keys(p.handlers).sort()).toEqual([...RAZORPAY_EVENTS].sort());
    await expect(p.handlers['payment.captured']!.fetch({ id: 1, provider: 'RAZORPAY', eventId: 'e', eventType: 'payment.captured', payload: {} }, { signal: new AbortController().signal }))
      .rejects.toBeInstanceOf(NotImplementedYetError);
  });
});
