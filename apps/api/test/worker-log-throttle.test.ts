import { describe, expect, it } from 'vitest';
import { createThrottledLogger, REMOVE_ON_COMPLETE } from '../src/worker/runtime.js';

describe('createThrottledLogger', () => {
  it('logs the first occurrence, suppresses repeats, then emits one summary with the suppressed count', () => {
    let t = 0;
    const out: Array<{ f: Record<string, unknown>; m: string }> = [];
    const log = createThrottledLogger((f, m) => out.push({ f, m }), 60_000, () => t);

    log('q:oom', { queue: 'q' }, 'worker error');
    for (let i = 0; i < 100_000; i++) { t += 1; log('q:oom', { queue: 'q' }, 'worker error'); }
    expect(out).toHaveLength(2);                       // first + one summary after 60 s, not 100k lines
    expect(out[1]!.f.suppressed).toBeGreaterThan(50_000);
  });

  it('throttles each key independently', () => {
    const out: string[] = [];
    const log = createThrottledLogger((_f, m) => out.push(m), 60_000, () => 0);
    log('a', {}, 'A'); log('b', {}, 'B'); log('a', {}, 'A2');
    expect(out).toEqual(['A', 'B']);
  });
});

describe('job retention', () => {
  it('is count-bounded so a 1-second scheduler cannot grow Redis without limit', () => {
    expect(REMOVE_ON_COMPLETE.count).toBeLessThanOrEqual(1000);
  });
});
