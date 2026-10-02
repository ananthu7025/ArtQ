// End-to-end tests for the admin shell (task 2.1): the real API (built) on :4001 against a fresh artq_e2e database on
// the docker-compose PostgreSQL/Redis, and the production admin build served by `vite preview` on :5173.
//   docker compose up -d --wait && pnpm --filter @artq/api build && pnpm --filter @artq/admin e2e
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const root = join(import.meta.dirname, '..', '..');
const example = Object.fromEntries(readFileSync(join(root, '.env.example'), 'utf8').split('\n')
  .filter((l) => l.trim() && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"(.*)"$/, '$1')]));
const pgPort = process.env.ARTQ_PG_PORT ?? '55432';
const E2E_DATABASE_URL = `postgresql://artq:artq@localhost:${pgPort}/artq_e2e`;
// Redis database 5 is reserved for e2e and flushed by the setup script.
const E2E_REDIS_URL = `redis://localhost:${process.env.ARTQ_REDIS_PORT ?? '56379'}/5`;
const apiEnv = { ...example, NODE_ENV: 'development', PORT: '4001', LOG_LEVEL: 'warn', DATABASE_URL: E2E_DATABASE_URL, E2E_DATABASE_URL, REDIS_URL: E2E_REDIS_URL, E2E_REDIS_URL, ADMIN_ORIGINS: 'http://localhost:5173', STOREFRONT_ORIGINS: 'http://localhost:3000' };

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure' },
  webServer: [
    {
      // Fresh database (migrations + seed) every run, then the built API.
      command: 'pnpm --dir ../api exec tsx scripts/e2e-setup.ts && node ../api/dist/server.js',
      url: 'http://localhost:4001/health/ready',
      env: apiEnv,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm exec vite build && pnpm exec vite preview --port 5173 --strictPort',
      url: 'http://localhost:5173',
      env: { VITE_API_URL: 'http://localhost:4001/v1' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
