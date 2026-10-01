import { describe, expect, it } from 'vitest';
import { jobId } from '../src/jobs/ids.js';

describe('jobId', () => {
  it('joins safe parts with hyphens (happy path)', () => {
    expect(jobId('outbox', 42, 3)).toBe('outbox-42-3');
    expect(jobId('wh', 7)).toBe('wh-7');
    expect(jobId('email.customer', 'AQ10001')).toBe('email.customer-AQ10001');
  });
  it('rejects colons (BullMQ "Custom Id cannot contain :")', () => {
    expect(() => jobId('wh:7')).toThrow(/invalid jobId part/);
    expect(() => jobId('outbox', 'a:b')).toThrow();
  });
  it('rejects empty, spaced, slashed and hyphenated parts (hyphen is the separator)', () => {
    for (const bad of ['', 'a b', 'a/b', 'a-b']) expect(() => jobId('x', bad)).toThrow(/invalid jobId part/);
  });
  it('rejects no parts, purely numeric ids and over-long ids', () => {
    expect(() => jobId()).toThrow(/at least one part/);
    expect(() => jobId(123)).toThrow(/numeric/);
    expect(() => jobId('x'.repeat(129))).toThrow(/too long/);
  });
});
