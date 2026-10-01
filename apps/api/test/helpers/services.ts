// Real PostgreSQL 16 and Redis for integration tests.
// CI sets TEST_DATABASE_URL / TEST_REDIS_URL (service containers); locally we start throwaway instances:
// PostgreSQL 16.14 from the pinned embedded-postgres binaries and redis-server from PATH (or REDIS_SERVER).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Redis } from 'ioredis';

export type Service = { url: string; stop: () => Promise<void> };

export async function freePort(): Promise<number> {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
}

export async function startRedis(): Promise<Service & { port: number }> {
  if (process.env.TEST_REDIS_URL) return { url: process.env.TEST_REDIS_URL, port: Number(new URL(process.env.TEST_REDIS_URL).port), stop: async () => {} };
  const port = await freePort();
  const proc = spawn(process.env.REDIS_SERVER ?? 'redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  const url = `redis://127.0.0.1:${port}`;
  const probe = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  probe.on('error', () => {});
  for (let i = 0; ; i++) {
    try { await probe.connect(); await probe.ping(); break; }
    catch (e) { if (i > 50) { proc.kill('SIGKILL'); throw new Error(`redis-server did not start: ${String(e)}. Install Redis or set TEST_REDIS_URL.`, { cause: e }); } await new Promise((r) => setTimeout(r, 100)); }
  }
  probe.disconnect();
  return { url, port, stop: async () => { proc.kill('SIGKILL'); } };
}

export async function startPostgres(): Promise<Service> {
  if (process.env.TEST_DATABASE_URL) return { url: process.env.TEST_DATABASE_URL, stop: async () => {} };
  const dir = mkdtempSync(join(tmpdir(), 'artq-api-pg-'));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: join(dir, 'data'), user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('artq_test');
  return {
    url: `postgresql://postgres:postgres@127.0.0.1:${port}/artq_test`,
    stop: async () => { await pg.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}
