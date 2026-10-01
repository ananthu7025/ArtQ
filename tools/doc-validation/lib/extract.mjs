// Extracts the validated artifacts from docs/database.md into .fixtures/.
// Blocks are located by an HTML marker on the line before the fence: <!-- validate:NAME -->
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..');
export const DOCS = join(ROOT, '..', '..', 'docs');
export const FIX = join(ROOT, '.fixtures');

export function extract() {
  const md = readFileSync(join(DOCS, 'database.md'), 'utf8');
  const re = /<!-- validate:([\w.-]+) -->\s*\n```(\w+)\n([\s\S]*?)```/g;
  const out = {};
  for (const m of md.matchAll(re)) out[m[1]] = m[3];
  for (const k of ['schema.prisma', '0002.sql', '0003.sql']) {
    if (!out[k]) throw new Error(`docs/database.md: missing <!-- validate:${k} --> block`);
  }
  mkdirSync(join(FIX, 'prisma'), { recursive: true });
  writeFileSync(join(FIX, 'prisma', 'schema.prisma'), out['schema.prisma']);
  writeFileSync(join(FIX, '0002.sql'), out['0002.sql']);
  writeFileSync(join(FIX, '0003.sql'), out['0003.sql']);
  return out;
}
