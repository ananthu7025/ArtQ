import { describe, expect, it } from 'vitest';
import { contrastRatio, MIN_RATIO, relativeLuminance } from '../src/contrast.js';
import { allowedPairs, color, forbiddenTextPairs, type ContrastPair } from '../src/tokens.js';

const hex = (t: ContrastPair['fg'] | ContrastPair['bg']) => (t.startsWith('#') ? t : color[t as keyof typeof color]);

describe('contrastRatio', () => {
  it('matches WCAG reference values', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#ffffff', '#00a99d')).toBeCloseTo(2.93, 2);
    expect(contrastRatio('#ffffff', '#00756f')).toBeCloseTo(5.56, 2);
  });
  it('is symmetric', () => { expect(contrastRatio('#00756f', '#ffffff')).toBe(contrastRatio('#ffffff', '#00756f')); });
  it('rejects malformed colours', () => {
    for (const bad of ['fff', '#fff', '#gggggg', 'teal', '']) expect(() => relativeLuminance(bad)).toThrow(TypeError);
  });
});

describe('design-system colour pairs (design-system.md §2.3)', () => {
  it.each(allowedPairs)('$fg on $bg ($where) meets the $use minimum', (p) => {
    const ratio = contrastRatio(hex(p.fg), hex(p.bg));
    expect(ratio).toBeGreaterThanOrEqual(MIN_RATIO[p.use as 'text' | 'ui']);
  });
  it.each(forbiddenTextPairs)('$fg on $bg ($where) is below 4.5:1 and must stay decorative', (p) => {
    expect(contrastRatio(hex(p.fg), hex(p.bg))).toBeLessThan(MIN_RATIO.text);
  });
});
