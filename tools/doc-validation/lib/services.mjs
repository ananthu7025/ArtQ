// Throwaway PostgreSQL and Redis processes for the checks.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

async function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
}

export function pgBinDir() {
  if (process.env.PG_BIN_DIR) return process.env.PG_BIN_DIR;
  // pinned PostgreSQL 16 binaries shipped by embedded-postgres for this platform
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@embedded-postgres', `${process.platform}-${process.arch}`, 'native', 'bin');
  if (!existsSync(dir)) throw new Error(`no embedded PostgreSQL for ${process.platform}-${process.arch}; set PG_BIN_DIR`);
  return dir;
}

export async function startPostgres() {
  const bin = pgBinDir();
  const dir = mkdtempSync(join(tmpdir(), 'artq-pg-'));
  const port = await freePort();
  execFileSync(join(bin, 'initdb'), ['-D', join(dir, 'data'), '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C'], { stdio: 'ignore' });
  execFileSync(join(bin, 'pg_ctl'), ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c max_connections=200 -c deadlock_timeout=200ms`,
    '-l', join(dir, 'pg.log'), '-w', 'start'], { stdio: 'ignore' });
  const version = execFileSync(join(bin, 'postgres'), ['--version']).toString().trim();
  return {
    version, port, host: dir,
    config: (database) => ({ host: dir, port, user: 'postgres', database }),
    stop() { try { execFileSync(join(bin, 'pg_ctl'), ['-D', join(dir, 'data'), '-m', 'immediate', 'stop'], { stdio: 'ignore' }); } finally { rmSync(dir, { recursive: true, force: true }); } },
  };
}

export async function startRedis() {
  const bin = process.env.REDIS_SERVER || 'redis-server';
  const port = await freePort();
  const p = spawn(bin, ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 300));
  if (p.exitCode !== null) throw new Error('redis-server failed to start (set REDIS_SERVER)');
  const version = execFileSync(bin, ['--version']).toString().trim().split(' ').find((x) => x.startsWith('v='));
  return { port, version, connection: { host: '127.0.0.1', port }, stop: () => p.kill('SIGKILL') };
}
