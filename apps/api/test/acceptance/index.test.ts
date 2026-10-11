// Task 7.1: every acceptance test in docs/tasklist.md ("Acceptance tests (required for launch)") is implemented — a
// test (API integration/acceptance, or Playwright) whose title carries its id. AT-14 is the staging restore and
// rollback drill (task 7.6), not an automated test. A new AT row without a test, or a test whose AT row is gone, fails.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const DRILLS: Record<string, string> = { 'AT-14': 'task 7.6 (staging restore and rollback drill)' };
const SEARCHED = ['apps/api/test', 'apps/web/e2e', 'apps/admin/e2e'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : /\.(test|spec)\.ts$/.test(name) ? [full] : [];
  });
}
/** Ids named in a test or describe title (`it('AT-05: …')`, `describe('✅ AT-13: …')`, `test('ACCEPTANCE AT-04: …')`). */
function taggedIds(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const f of SEARCHED.flatMap((d) => files(join(ROOT, d))).filter((x) => x !== import.meta.filename)) {   // never count this file
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\b(?:it|test|describe)\(\s*(['"`])((?:(?!\1).)*)\1/g)) {
      for (const id of m[2]!.match(/AT-\d{2}/g) ?? []) found.set(id, [...(found.get(id) ?? []), f.slice(ROOT.length + 1)]);
    }
  }
  return found;
}
const documented = () => [...readFileSync(join(ROOT, 'docs', 'tasklist.md'), 'utf8').matchAll(/^\| \*\*(AT-\d{2})\*\* \|/gm)].map((m) => m[1]!);

describe('acceptance tests (docs/tasklist.md)', () => {
  it('the table lists AT-01 … AT-24', () => {
    expect(documented()).toEqual(Array.from({ length: 24 }, (_, i) => `AT-${String(i + 1).padStart(2, '0')}`));
  });

  it('every AT except the staging drill has at least one test carrying its id', () => {
    const tagged = taggedIds();
    const missing = documented().filter((id) => !DRILLS[id] && !tagged.has(id));
    expect(missing).toEqual([]);
  });

  it('no test claims an AT that is not in the table, or a drill', () => {
    const ids = new Set(documented());
    const stray = [...taggedIds()].filter(([id]) => !ids.has(id) || DRILLS[id]).map(([id, where]) => `${id} in ${where.join(', ')}`);
    expect(stray).toEqual([]);
  });
});
