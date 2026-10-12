#!/usr/bin/env node
// Enforces architecture.md §1.1 for the Next.js storefront: no route handlers, no Server Actions,
// no middleware that talks to backend infrastructure. Exit 1 with a list of violations.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP = new Set(['node_modules', '.next', 'dist', '.turbo', 'coverage']);
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

export function findViolations(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      // Build output: `.next` and any other Next.js distDir such as `.next-e2e` (the Playwright build).
      if (statSync(full).isDirectory()) { if (!name.startsWith('.next')) walk(full); continue; }
      if (!CODE.test(name)) continue;
      const rel = relative(root, full).split(sep).join('/');
      if (/(^|\/)app\/(.*\/)?api\//.test(rel) || /(^|\/)pages\/api\//.test(rel)) out.push({ file: rel, rule: 'route-handler', message: 'API routes are not allowed in apps/web' });
      if (/(^|\/)app\/(.*\/)?route\.(ts|tsx|js|jsx|mjs)$/.test(rel)) out.push({ file: rel, rule: 'route-handler', message: 'route.* handlers are not allowed in apps/web' });
      const src = readFileSync(full, 'utf8');
      if (/^\s*['"]use server['"]\s*;?/m.test(src)) out.push({ file: rel, rule: 'server-action', message: '"use server" (Server Actions) is not allowed in apps/web' });
    }
  };
  walk(root);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.argv[2] ?? 'apps/web';
  const v = findViolations(root);
  for (const x of v) console.error(`${root}/${x.file}: [${x.rule}] ${x.message}`);
  if (v.length) { console.error(`\n${v.length} boundary violation(s): apps/web must stay frontend-only (docs/architecture.md §1.1).`); process.exit(1); }
  console.log(`web boundaries OK (${root})`);
}
