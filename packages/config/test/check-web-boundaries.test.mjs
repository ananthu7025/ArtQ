import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findViolations } from '../check-web-boundaries.mjs';

let dirs = [];
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'web-bound-'));
  dirs.push(root);
  for (const [p, content] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), content); }
  return root;
}
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

describe('findViolations', () => {
  it('passes a frontend-only app (happy path)', () => {
    const root = fixture({ 'app/page.tsx': 'export default function P(){return null}', 'app/shop/[slug]/page.tsx': "'use client';\nexport default 1", 'lib/api-client.ts': 'export const x = 1' });
    expect(findViolations(root)).toEqual([]);
  });
  it('flags app/api route handlers', () => {
    const v = findViolations(fixture({ 'app/api/cart/route.ts': 'export function POST(){}' }));
    expect(v.map((x) => x.rule)).toContain('route-handler');
  });
  it('flags route.ts anywhere under app/', () => {
    expect(findViolations(fixture({ 'app/feed/route.ts': 'export function GET(){}' }))).toHaveLength(1);
  });
  it('flags pages/api', () => {
    expect(findViolations(fixture({ 'pages/api/x.ts': 'export default 1' }))[0].rule).toBe('route-handler');
  });
  it('flags "use server" with either quote style', () => {
    expect(findViolations(fixture({ 'app/a.ts': '"use server";\nexport async function f(){}', 'app/b.ts': "  'use server'\n" }))).toHaveLength(2);
  });
  it('ignores the words inside strings or comments that are not directives', () => {
    expect(findViolations(fixture({ 'app/c.ts': "const s = 'we never use server actions';" }))).toEqual([]);
  });
  it('skips node_modules and .next', () => {
    expect(findViolations(fixture({ 'node_modules/x/app/api/route.ts': '1', '.next/server/app/api/route.js': '1' }))).toEqual([]);
  });
  it('ignores non-code files', () => {
    expect(findViolations(fixture({ 'app/api/readme.md': '# no' }))).toEqual([]);
  });
});
