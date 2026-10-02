// Prepares the end-to-end database: drop/create, real migrations, real seed (super admin), plus a STAFF user.
//   E2E_DATABASE_URL=postgresql://artq:artq@localhost:55432/artq_e2e tsx scripts/e2e-setup.ts
// Refuses to touch any database whose name is not artq_e2e.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { hashPassword } from '../src/lib/password.js';
import { runSeed } from '../src/seed/run.js';

export const E2E_USERS = {
  superAdmin: { email: 'owner@e2e.artq.in', password: 'e2e-owner-passphrase', name: 'Owner' },
  staff: { email: 'staff@e2e.artq.in', password: 'e2e-staff-passphrase', name: 'Store Staff' },
} as const;

const url = process.env.E2E_DATABASE_URL;
if (!url) throw new Error('E2E_DATABASE_URL is required');
const target = new URL(url);
if (target.pathname !== '/artq_e2e') throw new Error(`refusing to reset ${target.pathname}: only /artq_e2e may be reset`);

const admin = new URL(url);
admin.pathname = '/postgres';
const maint = new PrismaClient({ datasourceUrl: admin.toString() });
await maint.$executeRawUnsafe('DROP DATABASE IF EXISTS artq_e2e WITH (FORCE)');
await maint.$executeRawUnsafe('CREATE DATABASE artq_e2e');
await maint.$disconnect();

const api = join(dirname(fileURLToPath(import.meta.url)), '..');
const prismaCli = join(dirname(createRequire(join(api, 'package.json')).resolve('prisma/package.json')), 'build', 'index.js');
execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', join(api, 'prisma', 'schema.prisma')], { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });

const prisma = new PrismaClient({ datasourceUrl: url });
await runSeed(prisma, { admin: E2E_USERS.superAdmin });
await prisma.user.create({
  data: { email: E2E_USERS.staff.email, name: E2E_USERS.staff.name, role: 'STAFF', status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await hashPassword(E2E_USERS.staff.password) },
});
await prisma.$disconnect();

// A dedicated Redis database for e2e (rate-limit counters, session cache) starts empty every run, so consecutive runs
// do not inherit each other's login counts. Never flush database 0.
const redisUrl = process.env.E2E_REDIS_URL;
if (redisUrl) {
  const db = Number(new URL(redisUrl).pathname.slice(1) || 0);
  if (db === 0) throw new Error('E2E_REDIS_URL must select a dedicated Redis database (e.g. /5), never 0');
  const r = new Redis(redisUrl);
  await r.flushdb();
  r.disconnect();
}
console.log('e2e database ready');
