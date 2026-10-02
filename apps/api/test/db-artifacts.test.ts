// Task 1.1 static checks: migrations come verbatim from docs/database.md, are safe to deploy, and every aq_* function
// has exactly one typed wrapper.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error untyped .mjs script
import { checkDir, findDestructive, stripSql } from '../scripts/check-migrations.mjs';
// @ts-expect-error untyped .mjs script
import { drift, expectedFiles, extractBlocks, MIGRATIONS } from '../scripts/db-from-docs.mjs';

const API = join(import.meta.dirname, '..');
const MIG = join(API, 'prisma', 'migrations');
const tmp: string[] = [];
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'artq-art-')); tmp.push(d); return d; };

describe('db-from-docs (docs/database.md → prisma/)', () => {
  const files: Record<string, string> = expectedFiles();

  it('committed schema and migrations match the validated doc blocks', () => {
    expect(drift(API, files)).toEqual([]);
  });

  it('0002 and 0003 are the doc blocks verbatim (only a generated header is added)', () => {
    const md = readFileSync(join(API, '..', '..', 'docs', 'database.md'), 'utf8');
    const b = extractBlocks(md);
    for (const [dir, key] of [[MIGRATIONS[1], '0002.sql'], [MIGRATIONS[2], '0003.sql']] as const) {
      const sql = readFileSync(join(MIG, dir, 'migration.sql'), 'utf8');
      expect(sql.split('\n')[0]).toMatch(/^-- GENERATED from docs\/database\.md/);
      expect(sql.slice(sql.indexOf('\n') + 1)).toBe(b[key]);
    }
  });

  it('detects a hand edit and a missing file', () => {
    const d = tempDir();
    cpSync(join(API, 'prisma'), join(d, 'prisma'), { recursive: true });
    const f = join(d, 'prisma', 'migrations', MIGRATIONS[2], 'migration.sql');
    writeFileSync(f, readFileSync(f, 'utf8') + '\n-- local tweak\n');
    rmSync(join(d, 'prisma', 'migrations', 'migration_lock.toml'));
    expect(drift(d, files).sort()).toEqual([`prisma/migrations/${MIGRATIONS[2]}/migration.sql`, 'prisma/migrations/migration_lock.toml'].sort());
  });

  it('rejects a doc with a missing or duplicated block', () => {
    const ok = '<!-- validate:schema.prisma -->\n```prisma\nx\n```\n<!-- validate:0002.sql -->\n```sql\ny\n```\n<!-- validate:0003.sql -->\n```sql\nz\n```\n';
    expect(Object.keys(extractBlocks(ok)).sort()).toEqual(['0002.sql', '0003.sql', 'schema.prisma']);
    expect(() => extractBlocks(ok.replace('validate:0003.sql', 'validate:other'))).toThrow(/missing <!-- validate:0003\.sql -->/);
    expect(() => extractBlocks(ok + '<!-- validate:0002.sql -->\n```sql\nagain\n```\n')).toThrow(/duplicate/);
  });

  it('0001_init is non-empty generated DDL', () => {
    const sql = files[`prisma/migrations/${MIGRATIONS[0]}/migration.sql`]!;
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(74);
  });
});

describe('check-migrations (destructive SQL guard)', () => {
  it('the committed migrations are clean', () => {
    expect(checkDir(MIG)).toEqual({});
  });

  it.each([
    ['DROP TABLE "carts";', 'drop'],
    ['ALTER TABLE "orders" DROP COLUMN "note";', 'drop'],
    ['DROP INDEX "products_search_gin";', 'drop'],
    ['ALTER TABLE "products" DROP CONSTRAINT "products_category_matches_type_fk";', 'drop'],
    ['drop type "OrderStatus";', 'drop'],
    ['DROP FUNCTION aq_emit(text,text,text,jsonb,text[]);', 'drop'],
    ['TRUNCATE "sessions";', 'truncate'],
    ['ALTER TABLE "users" RENAME COLUMN "name" TO "full_name";', 'rename'],
    ['ALTER TABLE "users" RENAME TO "people";', 'rename'],
    ['ALTER TABLE "orders" ALTER COLUMN "total" TYPE BIGINT;', 'type-change'],
    ['ALTER TABLE "orders" ALTER COLUMN "total" SET DATA TYPE BIGINT;', 'type-change'],
    ['ALTER TABLE "orders" ALTER COLUMN "note" SET NOT NULL;', 'set-not-null'],
    ['DELETE FROM "sessions";', 'delete'],
    ['UPDATE "orders" SET note = NULL;', 'update'],
  ])('flags %s', (sql, rule) => {
    const found = findDestructive(`-- migration\n${sql}\n`);
    expect(found.map((f: { rule: string }) => f.rule)).toContain(rule);
    expect(found.find((f: { rule: string }) => f.rule === rule).line).toBe(2);
  });

  it('flags a statement split across lines', () => {
    expect(findDestructive('DROP\n  TABLE "x";').map((f: { rule: string }) => f.rule)).toEqual(['drop']);
  });

  it.each([
    ['additive DDL', 'CREATE TABLE "x" (id INT);\nALTER TABLE "x" ADD COLUMN "y" INT;\nCREATE INDEX CONCURRENTLY "i" ON "x"("y");'],
    ['FK actions', 'ALTER TABLE "a" ADD CONSTRAINT "f" FOREIGN KEY ("b") REFERENCES "b"("id") ON DELETE CASCADE ON UPDATE CASCADE;'],
    ['function bodies', 'CREATE FUNCTION f() RETURNS void AS $$ BEGIN DELETE FROM t; DROP TABLE x; END $$ LANGUAGE plpgsql;'],
    ['tagged dollar quotes', 'CREATE FUNCTION f() RETURNS void AS $body$ UPDATE t SET a = 1; $body$ LANGUAGE sql;'],
    ['comments', '-- DROP TABLE x;\n/* TRUNCATE y; */\nSELECT 1;'],
    ['string literals', "COMMENT ON TABLE t IS 'do not DROP TABLE this';"],
    ['temp tables dropped on commit', 'CREATE TEMP TABLE _x (a INT) ON COMMIT DROP;'],
  ])('ignores %s', (_name, sql) => {
    expect(findDestructive(sql)).toEqual([]);
  });

  it('allows destructive SQL in a contract-phase migration, but not a bare or empty marker', () => {
    expect(findDestructive('-- contract-phase: column unused since release 2026.11\nALTER TABLE "x" DROP COLUMN "y";')).toEqual([]);
    expect(findDestructive('-- contract-phase:\nALTER TABLE "x" DROP COLUMN "y";')).not.toEqual([]);
    expect(findDestructive('-- contract phase: no\nALTER TABLE "x" DROP COLUMN "y";')).not.toEqual([]);
  });

  it('stripSql keeps line numbers', () => {
    const s = 'a\n$$\nDROP\n$$\nb';
    expect(stripSql(s).split('\n')).toHaveLength(5);
  });

  it('checkDir reports the offending migration by name', () => {
    const d = tempDir();
    cpSync(MIG, d, { recursive: true });
    writeFileSync(join(d, 'migration_lock.toml'), 'provider = "postgresql"\n');
    const bad = join(d, '0004_drop_note');
    cpSync(join(d, MIGRATIONS[0]), bad, { recursive: true });
    writeFileSync(join(bad, 'migration.sql'), 'ALTER TABLE "orders" DROP COLUMN "note";\n');
    const problems = checkDir(d);
    expect(Object.keys(problems)).toEqual(['0004_drop_note']);
    expect(problems['0004_drop_note'][0]).toMatchObject({ rule: 'drop', line: 1 });
  });
});

describe('typed wrappers (src/db/functions.ts)', () => {
  it('every aq_* function in the migrations has exactly one wrapper call, and no wrapper calls an unknown function', () => {
    const defined = new Set<string>();
    for (const d of readdirSync(MIG).filter((n) => !n.endsWith('.toml'))) {
      for (const m of readFileSync(join(MIG, d, 'migration.sql'), 'utf8').matchAll(/FUNCTION (aq_\w+)\s*\(/g)) defined.add(m[1]!);
    }
    const src = readFileSync(join(API, 'src', 'db', 'functions.ts'), 'utf8');
    const called = [...src.matchAll(/\b(aq_\w+)\(/g)].map((m) => m[1]!);
    expect(new Set(called)).toEqual(defined);
    expect(called).toHaveLength(defined.size);
  });
});
