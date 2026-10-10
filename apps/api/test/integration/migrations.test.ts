// Task 1.1: migrations 0001–0003 apply on an empty PostgreSQL 16 with the real `prisma migrate deploy`.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_ROOT, createEmptyDatabase, createMigratedDatabase, migrateDeploy, MIGRATIONS_DIR, type TestDb } from '../helpers/db.js';
import { startPostgres, type Service } from '../helpers/services.js';

const require = createRequire(join(API_ROOT, 'package.json'));
const PRISMA = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');
const prisma = (args: string[], url: string) =>
  execFileSync(process.execPath, [PRISMA, ...args], { env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' }, stdio: 'pipe' }).toString();

/** Objects created by 0002 that Prisma's schema language cannot express (it reports them as drift to drop). */
const PRISMA_BLIND = [
  'ALTER TABLE "products" DROP CONSTRAINT "products_category_matches_type_fk";',
  'DROP INDEX "products_name_trgm";',
  'DROP INDEX "products_search_gin";',
  'DROP INDEX "products_tags_gin";',
];

let pg: Service;
beforeAll(async () => { pg = await startPostgres(); }, 120_000);
afterAll(async () => { await pg?.stop(); });

describe('prisma migrate deploy on an empty database', () => {
  let db: TestDb;
  beforeAll(async () => { db = await createMigratedDatabase(pg.url); }, 120_000);
  afterAll(async () => { await db?.drop(); });

  it('records the generated migrations 0001–0003 and the later ones (0004+) as applied', async () => {
    const rows = await db.prisma.$queryRaw<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
      SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name`;
    expect(rows.map((r) => r.migration_name)).toEqual(['0001_init', '0002_constraints_search_integrity', '0003_money_stock_functions', '0004_import_initial_stock', '0005_refresh_products_lock_first', '0006_coupon_reverse', '0007_place_cod_order', '0008_dispatch_order', '0009_cancel_order', '0010_credit_note', '0011_returns', '0012_rto_lost_cod']);
    expect(rows.every((r) => r.finished_at !== null && r.rolled_back_at === null)).toBe(true);
  });

  it('creates the 74 tables, the extensions and every aq_* function', async () => {
    const tables = await db.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`;
    expect(Number(tables[0]!.n)).toBe(74);
    const ext = await db.prisma.$queryRaw<{ extname: string }[]>`SELECT extname FROM pg_extension ORDER BY extname`;
    expect(ext.map((e) => e.extname)).toEqual(expect.arrayContaining(['citext', 'pg_trgm', 'unaccent']));
    const fns = await db.prisma.$queryRaw<{ proname: string }[]>`
      SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'aq\\_%' ORDER BY proname`;
    expect(fns).toHaveLength(58);   // 39 from 0003 + aq_import_initial_stock (0004) + aq_reverse_coupon (0006) + aq_place_cod_order (0007) + aq_dispatch_order (0008) + aq_cancel_order (0009) + aq_issue_credit_note (0010) + 8 return functions (0011) + 5 RTO / lost / COD remittance functions (0012)
    expect(fns.map((f) => f.proname)).toContain('aq_import_initial_stock');
    expect(fns.map((f) => f.proname)).toContain('aq_reverse_coupon');
  });

  it('re-running deploy is a no-op', () => {
    expect(migrateDeploy(db.url)).toMatch(/No pending migrations to apply/);
  });

  it('replaying the migrations reproduces the database exactly (no hidden manual changes)', async () => {
    const shadow = await createEmptyDatabase(pg.url);
    try {
      const out = prisma(['migrate', 'diff', '--from-migrations', MIGRATIONS_DIR, '--shadow-database-url', shadow.url, '--to-url', db.url, '--script'], db.url);
      expect(out.split('\n').filter((l) => l.trim() && !l.startsWith('--'))).toEqual([]);
    } finally {
      await shadow.drop();
    }
  });

  it('schema.prisma and the database differ only by the documented Prisma-blind objects', () => {
    const out = prisma(['migrate', 'diff', '--from-url', db.url, '--to-schema-datamodel', join(API_ROOT, 'prisma', 'schema.prisma'), '--script'], db.url);
    expect(out.split('\n').filter((l) => l.trim() && !l.startsWith('--')).sort()).toEqual([...PRISMA_BLIND].sort());
  });
});

describe('failure paths', () => {
  it('a failing migration aborts deploy and is recorded as failed (release must stop)', async () => {
    const empty = await createEmptyDatabase(pg.url);
    const dir = mkdtempSync(join(tmpdir(), 'artq-mig-'));
    try {
      cpSync(join(API_ROOT, 'prisma'), join(dir, 'prisma'), { recursive: true });
      const bad = join(dir, 'prisma', 'migrations', '0099_broken');
      cpSync(join(dir, 'prisma', 'migrations', '0003_money_stock_functions'), bad, { recursive: true });
      writeFileSync(join(bad, 'migration.sql'), 'ALTER TABLE no_such_table ADD COLUMN x INT;\n');
      expect(() => prisma(['migrate', 'deploy', '--schema', join(dir, 'prisma', 'schema.prisma')], empty.url)).toThrow(/no_such_table|P3018/);
      const c = new PrismaClient({ datasourceUrl: empty.url });
      try {
        const rows = await c.$queryRaw<{ migration_name: string; finished_at: Date | null }[]>`SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY 1`;
        expect(rows.map((r) => [r.migration_name, r.finished_at !== null])).toEqual([
          ['0001_init', true], ['0002_constraints_search_integrity', true], ['0003_money_stock_functions', true], ['0004_import_initial_stock', true], ['0005_refresh_products_lock_first', true], ['0006_coupon_reverse', true], ['0007_place_cod_order', true], ['0008_dispatch_order', true], ['0009_cancel_order', true], ['0010_credit_note', true], ['0011_returns', true], ['0012_rto_lost_cod', true], ['0099_broken', false],
        ]);
        // a later deploy refuses to continue past the failed migration
        expect(() => prisma(['migrate', 'deploy', '--schema', join(dir, 'prisma', 'schema.prisma')], empty.url)).toThrow(/P3009|failed migrations/);
      } finally {
        await c.$disconnect();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await empty.drop();
    }
  });

  it('deploy against an unreachable database fails', () => {
    expect(() => migrateDeploy('postgresql://postgres:postgres@127.0.0.1:1/none')).toThrow(/P1001|Can't reach/);
  });
});
