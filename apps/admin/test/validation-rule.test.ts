// CLAUDE.md "Validation rule": the red border for invalid fields is defined once, globally, for every input/select/textarea.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('validation styling', () => {
  it('styles.css gives every aria-invalid input, select and textarea a red border', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8');
    expect(css).toMatch(/:is\(input, select, textarea\)\[aria-invalid="true"\]\s*\{[^}]*border-color:\s*var\(--color-danger-700\)/);
  });
});
