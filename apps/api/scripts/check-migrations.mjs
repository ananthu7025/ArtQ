// Migration safety check (architecture.md §12 "expand → migrate → contract").
// Fails when a migration contains a destructive or backward-incompatible statement, unless the migration file carries a
// `-- contract-phase: <reason>` line (the release in which the running code no longer uses the old shape).
//
//   node scripts/check-migrations.mjs [migrationsDir]
//
// Function/trigger bodies ($$ … $$), string literals and comments are ignored: only top-level DDL/DML is checked.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULES = [
  { id: 'drop', re: /\bDROP\s+(TABLE|COLUMN|SCHEMA|DATABASE|TYPE|INDEX|CONSTRAINT|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|EXTENSION|FUNCTION|TRIGGER)\b/i },
  { id: 'truncate', re: /\bTRUNCATE\b/i },
  { id: 'rename', re: /\bRENAME\b/i },
  { id: 'type-change', re: /\bALTER\s+COLUMN\s+("[^"]+"|\w+)\s+(SET\s+DATA\s+)?TYPE\b/i },
  { id: 'set-not-null', re: /\bALTER\s+COLUMN\s+("[^"]+"|\w+)\s+SET\s+NOT\s+NULL\b/i },
  { id: 'delete', re: /\bDELETE\s+FROM\b/i },
  { id: 'update', re: /\bUPDATE\s+("[^"]+"|\w+)\s+SET\b/i },
];

const MARKER = /^[ \t]*--[ \t]*contract-phase:[ \t]*\S/m; // the reason must be on the marker line

/** Removes comments, string literals and dollar-quoted bodies, keeping line breaks so line numbers stay correct. */
export function stripSql(sql) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  return sql
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, blank)
    .replace(/'(?:[^']|'')*'/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/--[^\n]*/g, blank);
}

/** Destructive statements in one migration: [{ rule, line, text }]. Empty when allowed by the contract-phase marker. */
export function findDestructive(sql) {
  if (MARKER.test(sql)) return [];
  const lines = stripSql(sql).split('\n');
  const original = sql.split('\n');
  const out = [];
  lines.forEach((l, i) => {
    for (const r of RULES) if (r.re.test(l)) out.push({ rule: r.id, line: i + 1, text: original[i].trim() });
  });
  // Statements split across lines (e.g. "DROP\n  TABLE") are caught on the joined text.
  const joined = lines.join(' ');
  for (const r of RULES) {
    if (r.re.test(joined) && !out.some((o) => o.rule === r.id)) out.push({ rule: r.id, line: 0, text: '(multi-line statement)' });
  }
  return out;
}

/** Checks every <dir>/<migration>/migration.sql; returns problems keyed by migration name. */
export function checkDir(dir) {
  const problems = {};
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, 'migration.sql');
    if (!statSync(join(dir, name)).isDirectory()) continue;
    const found = findDestructive(readFileSync(file, 'utf8'));
    if (found.length) problems[name] = found;
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'migrations');
  const problems = checkDir(dir);
  const names = Object.keys(problems);
  if (names.length) {
    for (const n of names) {
      console.error(`${n}/migration.sql`);
      for (const p of problems[n]) console.error(`  line ${p.line} [${p.rule}] ${p.text}`);
    }
    console.error('\nDestructive or incompatible SQL. Ship it in a later release with a `-- contract-phase: <reason>` line (architecture.md §12).');
    process.exit(1);
  }
  console.log(`migrations OK (${readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory()).length} checked, no destructive SQL)`);
}
