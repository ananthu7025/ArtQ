// Storefront browser tests (task 3.1+): the built API on :4001 against a fresh artq_e2e database (plus the storefront
// fixture: types, categories, settings), and the production storefront build (`.next-e2e`) on :3100 built from it.
//   docker compose up -d --wait && pnpm --filter @artq/api build && pnpm --filter @artq/web e2e
// Pages are prerendered from the API at build time (ISR), so the data is seeded before the storefront is built.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const root = join(import.meta.dirname, '..', '..');
const example = Object.fromEntries(readFileSync(join(root, '.env.example'), 'utf8').split('\n')
  .filter((l) => l.trim() && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"(.*)"$/, '$1')]));
const webPort = process.env.E2E_WEB_PORT ?? '3100';
const webOrigin = `http://localhost:${webPort}`;
const pgPort = process.env.ARTQ_PG_PORT ?? '55432';
const E2E_DATABASE_URL = `postgresql://artq:artq@localhost:${pgPort}/artq_e2e`;
const E2E_REDIS_URL = `redis://localhost:${process.env.ARTQ_REDIS_PORT ?? '56379'}/5`;   // db 5 is reserved for e2e
const API = 'http://localhost:4001';
const apiEnv = { ...example, NODE_ENV: 'development', PORT: '4001', LOG_LEVEL: 'warn', DATABASE_URL: E2E_DATABASE_URL, E2E_DATABASE_URL, REDIS_URL: E2E_REDIS_URL, E2E_REDIS_URL, ADMIN_ORIGINS: 'http://localhost:5173', STOREFRONT_ORIGINS: webOrigin, WEB_URL: webOrigin };

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  use: { baseURL: webOrigin, trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'pnpm --dir ../api exec tsx scripts/e2e-setup.ts && pnpm --dir ../api exec tsx scripts/e2e-storefront-seed.ts && (node ../api/dist/worker.js & exec node ../api/dist/server.js)',
      url: `${API}/health/ready`,
      env: apiEnv,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // Waits for the API so the build prerenders real data, then serves the production build.
      command: `node -e "const u='${API}/health/ready';(async()=>{for(let i=0;i<240;i++){try{if((await fetch(u)).ok)process.exit(0)}catch{}await new Promise(r=>setTimeout(r,500))}process.exit(1)})()" && pnpm exec next build && pnpm exec next start --port ${webPort}`,
      url: webOrigin,
      env: { NEXT_PUBLIC_API_URL: `${API}/v1`, NEXT_DIST_DIR: '.next-e2e' },
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
