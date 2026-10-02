// Fresh, fully migrated databases for integration tests.
// The migrations run once per server with the real `prisma migrate deploy` into a template database
// (artq_tpl_<hash of the migration files>); each test file then gets a cheap clone (CREATE DATABASE … TEMPLATE).
// An advisory lock serialises template creation across parallel test files sharing one server (CI, compose).
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

export const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MIGRATIONS_DIR = join(API_ROOT, 'prisma', 'migrations');

export function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = '/' + db;
  return u.toString();
}

function migrationsHash(): string {
  const h = createHash('sha256');
  for (const d of readdirSync(MIGRATIONS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    h.update(d).update(readFileSync(join(MIGRATIONS_DIR, d, 'migration.sql')));
  }
  return h.digest('hex').slice(0, 12);
}

/** Runs the real `prisma migrate deploy` against `url`. Returns combined output. */
export function migrateDeploy(url: string): string {
  const require = createRequire(join(API_ROOT, 'package.json'));
  const cli = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');
  return execFileSync(process.execPath, [cli, 'migrate', 'deploy', '--schema', join(API_ROOT, 'prisma', 'schema.prisma')], {
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    stdio: 'pipe',
  }).toString();
}

export type TestDb = { url: string; name: string; prisma: PrismaClient; drop: () => Promise<void> };

/** Creates an empty database (no migrations) on the server behind `serverUrl`. */
export async function createEmptyDatabase(serverUrl: string): Promise<{ url: string; name: string; drop: () => Promise<void> }> {
  const name = `artq_t_${randomBytes(6).toString('hex')}`;
  const admin = new PrismaClient({ datasourceUrl: withDatabase(serverUrl, 'postgres') });
  try { await admin.$executeRawUnsafe(`CREATE DATABASE ${name}`); } finally { await admin.$disconnect(); }
  return { url: withDatabase(serverUrl, name), name, drop: () => dropDatabase(serverUrl, name) };
}

async function dropDatabase(serverUrl: string, name: string) {
  const admin = new PrismaClient({ datasourceUrl: withDatabase(serverUrl, 'postgres') });
  try { await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.$disconnect(); }
}

/** A fresh database with migrations 0001–000n applied, plus a Prisma client connected to it. */
export async function createMigratedDatabase(serverUrl: string): Promise<TestDb> {
  const tpl = `artq_tpl_${migrationsHash()}`;
  const name = `artq_t_${randomBytes(6).toString('hex')}`;
  // connection_limit=1 keeps the session-level advisory lock and the DDL on one connection.
  const admin = new PrismaClient({ datasourceUrl: withDatabase(serverUrl, 'postgres') + '?connection_limit=1' });
  try {
    await admin.$executeRawUnsafe(`SELECT pg_advisory_lock(hashtext('artq_test_template'))`);
    try {
      const ready = await admin.$queryRawUnsafe<{ ok: boolean }[]>(
        `SELECT shobj_description(oid, 'pg_database') = 'migrated' AS ok FROM pg_database WHERE datname = $1`, tpl);
      if (!ready[0]?.ok) {
        await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${tpl} WITH (FORCE)`);
        await admin.$executeRawUnsafe(`CREATE DATABASE ${tpl}`);
        migrateDeploy(withDatabase(serverUrl, tpl));
        await admin.$executeRawUnsafe(`COMMENT ON DATABASE ${tpl} IS 'migrated'`);
      }
      await admin.$executeRawUnsafe(`CREATE DATABASE ${name} TEMPLATE ${tpl}`);
    } finally {
      await admin.$executeRawUnsafe(`SELECT pg_advisory_unlock(hashtext('artq_test_template'))`);
    }
  } finally {
    await admin.$disconnect();
  }
  const url = withDatabase(serverUrl, name);
  const prisma = new PrismaClient({ datasourceUrl: url });
  return { url, name, prisma, drop: async () => { await prisma.$disconnect(); await dropDatabase(serverUrl, name); } };
}
