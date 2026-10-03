// scripts/seed-demo.ts must never touch a production or remote database (it loads demo contact details and products).
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const run = (env: Record<string, string | undefined>) => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(import.meta.dirname, '..', 'scripts', 'seed-demo.ts')], {
    env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

describe('demo seed guards (no database is touched)', () => {
  it('no DATABASE_URL → refuses', () => {
    const r = run({});
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('DATABASE_URL is required');
  });
  it('NODE_ENV=production → refuses, even for a local database', () => {
    const r = run({ DATABASE_URL: 'postgresql://artq:artq@localhost:1/artq', NODE_ENV: 'production' });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('refusing to load demo data with NODE_ENV=production');
  });
  it.each(['db.artq.in', '10.0.0.5', 'artq-prod.abc123.ap-south-1.rds.amazonaws.com'])('a database on %s → refuses (local only)', (host) => {
    const r = run({ DATABASE_URL: `postgresql://artq:artq@${host}:5432/artq`, NODE_ENV: 'development' });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(`refusing to load demo data into ${host}: local databases only`);
  });
});
