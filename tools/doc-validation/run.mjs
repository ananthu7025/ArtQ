// ArtQ documentation validation runner. See README.md for what this does and does NOT prove.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { extract, FIX, ROOT } from './lib/extract.mjs';
import { startPostgres, startRedis } from './lib/services.mjs';

const only = process.argv.slice(2);
const results = [];
const log = (s) => process.stdout.write(s + '\n');

const blocks = extract();
const prismaBin = join(ROOT, 'node_modules', '.bin', 'prisma');
const env = { ...process.env, DATABASE_URL: 'postgresql://x@localhost/x', PRISMA_HIDE_UPDATE_MESSAGE: '1' };
const schema = join(FIX, 'prisma', 'schema.prisma');
execFileSync(prismaBin, ['validate', '--schema', schema], { env, stdio: 'pipe' });
const ddl = execFileSync(prismaBin, ['migrate', 'diff', '--from-empty', '--to-schema-datamodel', schema, '--script'], { env }).toString();
writeFileSync(join(FIX, '0001.sql'), ddl);
const prismaVersion = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'prisma', 'package.json'))).version;
results.push({ id: 'C00', title: `Prisma ${prismaVersion} validate + DDL generation`, ok: true, detail: `${(ddl.match(/CREATE TABLE/g) || []).length} tables` });

const pgsrv = await startPostgres();
let redis = null;
try {
  const admin = new pg.Client(pgsrv.config('postgres'));
  await admin.connect();
  await admin.query('CREATE DATABASE artq_template');
  const t = new pg.Client(pgsrv.config('artq_template'));
  await t.connect();
  // 0001–0003 and the doc-owned later migrations come from the doc; the other later migrations (0004+) are the
  // committed files, applied in number order so a doc-owned function can rely on them (0009 calls 0006's function).
  const MIG = join(ROOT, '..', '..', 'apps', 'api', 'prisma', 'migrations');
  const later = readdirSync(MIG).filter((d) => /^\d{4}_/.test(d) && d.slice(0, 4) > '0003').sort();
  const applied = ['0001', '0002', '0003'];
  for (const f of ['0001.sql', '0002.sql', '0003.sql']) await t.query(readFileSync(join(FIX, f), 'utf8'));
  for (const d of later) {
    const n = d.slice(0, 4);
    const fromDoc = blocks.later.includes(`${n}.sql`);
    await t.query(readFileSync(fromDoc ? join(FIX, `${n}.sql`) : join(MIG, d, 'migration.sql'), 'utf8'));
    applied.push(fromDoc ? n : `${n}(file)`);
  }
  const missing = blocks.later.filter((k) => !later.some((d) => d.startsWith(k.slice(0, 4))));
  if (missing.length) throw new Error(`doc blocks without a migration directory: ${missing.join(', ')}`);
  await t.end();
  results.push({ id: 'C01', title: `Migrations ${applied.join('+')} on ${pgsrv.version}`, ok: true, detail: 'doc blocks + committed later migrations applied' });

  const files = readdirSync(join(ROOT, 'checks')).filter((f) => f.endsWith('.mjs')).sort();
  for (const f of files) {
    const mod = (await import(join(ROOT, 'checks', f))).default;
    if (only.length && !only.includes(mod.id)) continue;
    const db = 'c_' + mod.id.toLowerCase();
    await admin.query(`CREATE DATABASE ${db} TEMPLATE artq_template`);
    if (mod.needs?.includes('redis') && !redis) redis = await startRedis();
    const t0 = Date.now();
    try {
      const detail = await mod.run({ cfg: pgsrv.config(db), redis, pgVersion: pgsrv.version });
      results.push({ id: mod.id, title: mod.title, ok: true, detail, ms: Date.now() - t0 });
    } catch (e) {
      results.push({ id: mod.id, title: mod.title, ok: false, detail: e.stack?.split('\n').slice(0, 3).join(' | '), ms: Date.now() - t0 });
    }
  }
  await admin.end();
} finally {
  pgsrv.stop();
  redis?.stop();
}

log(`\nArtQ doc validation: ${pgsrv.version}${redis ? ', Redis ' + redis.version : ''}, Node ${process.version}`);
for (const r of results) log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.title}\n      ${r.detail}`);
mkdirSync(join(ROOT, '.tmp'), { recursive: true });
writeFileSync(join(ROOT, '.tmp', `results-${pgsrv.version.split(' ').pop()}.json`), JSON.stringify({ pg: pgsrv.version, node: process.version, results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
