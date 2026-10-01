import { Router } from 'express';
import { healthResponse } from '@artq/shared';

export type Check = () => Promise<void>;
export type ReadinessChecks = Record<string, Check>;

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(() => { clearTimeout(t); resolve(); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });
}

/** /health = process is up. /health/ready = every dependency answers within the timeout (architecture.md §15). */
export function healthRouter(version: string, checks: ReadinessChecks, timeoutMs = 2000): Router {
  const r = Router();
  r.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store').json(healthResponse.parse({ status: 'ok', service: 'api', version }));
  });
  r.get('/health/ready', async (_req, res) => {
    const results = await Promise.all(Object.entries(checks).map(async ([name, fn]) => {
      try { await withTimeout(fn(), timeoutMs); return [name, { ok: true }] as const; }
      catch (e) { return [name, { ok: false, error: e instanceof Error ? e.message : String(e) }] as const; }
    }));
    const ready = results.every(([, v]) => v.ok);
    res.status(ready ? 200 : 503).set('Cache-Control', 'no-store').json({ status: ready ? 'ready' : 'not_ready', checks: Object.fromEntries(results) });
  });
  return r;
}
