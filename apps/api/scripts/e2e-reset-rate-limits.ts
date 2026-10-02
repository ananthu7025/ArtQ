// E2E helper: clears the rate-limit counters (keys `rl:*`) in the dedicated e2e Redis database, so each spec file starts
// with a fresh login budget instead of sharing the real 10/min limit across the whole run. Sessions are untouched.
//   E2E_REDIS_URL=redis://localhost:56379/5 tsx scripts/e2e-reset-rate-limits.ts
// Refuses database 0 (the same guard as e2e-setup.ts).
import { Redis } from 'ioredis';

const url = process.env.E2E_REDIS_URL;
if (!url) throw new Error('E2E_REDIS_URL is required');
const db = Number(new URL(url).pathname.slice(1) || 0);
if (db === 0) throw new Error('E2E_REDIS_URL must select a dedicated Redis database (e.g. /5), never 0');

const r = new Redis(url);
try {
  let cursor = '0';
  let removed = 0;
  do {
    const [next, keys] = await r.scan(cursor, 'MATCH', 'rl:*', 'COUNT', 500);
    if (keys.length) removed += await r.del(...keys);
    cursor = next;
  } while (cursor !== '0');
  process.stdout.write(`cleared ${removed} rate-limit counters\n`);
} finally {
  r.disconnect();
}
