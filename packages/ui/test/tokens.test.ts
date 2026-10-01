import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { color } from '../src/tokens.js';

const read = (f: string) => readFileSync(join(import.meta.dirname, '..', 'src', f), 'utf8');
const vars = (css: string, prefix: string) =>
  Object.fromEntries([...css.matchAll(new RegExp(`--${prefix}([a-z0-9-]+):\\s*(#[0-9a-fA-F]{6})`, 'g'))].map((m) => [m[1], m[2]!.toLowerCase()]));

describe('token files stay in sync with tokens.ts', () => {
  it('tokens.css defines exactly the colour tokens', () => {
    expect(vars(read('tokens.css'), '')).toEqual(color);
  });
  it('theme.css (Tailwind) defines exactly the colour tokens', () => {
    expect(vars(read('theme.css'), 'color-')).toEqual(color);
  });
  it('every token is a lowercase #rrggbb value', () => {
    for (const [k, v] of Object.entries(color)) expect(v, k).toMatch(/^#[0-9a-f]{6}$/);
  });
});
