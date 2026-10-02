import { describe, expect, it } from 'vitest';
import { describeReadiness, READINESS } from './readiness.js';

describe('describeReadiness', () => {
  it('names each failure with its check and fix, keeping the order', () => {
    expect(describeReadiness(['no_tax', 'no_image'])).toEqual([
      { code: 'no_tax', check: 'Tax classification', fix: READINESS.no_tax.fix },
      { code: 'no_image', check: 'Image', fix: READINESS.no_image.fix },
    ]);
  });
  it('empty in, empty out; an unknown code is shown rather than dropped', () => {
    expect(describeReadiness([])).toEqual([]);
    expect(describeReadiness(['new_check'])).toEqual([{ code: 'new_check', check: 'new_check', fix: 'See the product readiness panel.' }]);
  });
  it('every check has a non-empty label and fix', () => {
    for (const [code, r] of Object.entries(READINESS)) expect([code, r.check.length > 0, r.fix.length > 10]).toEqual([code, true, true]);
  });
});
