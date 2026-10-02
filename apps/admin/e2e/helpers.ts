// Shared E2E helpers. Every spec file resets the login rate-limit counters in the e2e Redis database before it runs:
// the limit is real (10 logins/min per network) and the whole suite logs in more than that within a minute, so without
// this the outcome would depend on where the minute boundary falls.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const API = join(import.meta.dirname, '..', '..', 'api');
const E2E_REDIS_URL = `redis://localhost:${process.env.ARTQ_REDIS_PORT ?? '56379'}/5`;

export function resetRateLimitsBeforeAll() {
  test.beforeAll(() => {
    execFileSync('pnpm', ['--dir', API, 'exec', 'tsx', 'scripts/e2e-reset-rate-limits.ts'], { env: { ...process.env, E2E_REDIS_URL }, stdio: 'pipe' });
  });
}

/**
 * axe (WCAG 2.1 AA, incl. colour contrast) on the settled page: finite animations (toast fade-in, dialog open) are
 * waited for first, otherwise a half-transparent element is measured. Endless ones (spinners) are ignored.
 */
export async function axeClean(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => `${n.target.join(' ')} ${n.failureSummary ?? ''}`).join(' | ')}`)).toEqual([]);
}

const MAILPIT = `http://localhost:${process.env.ARTQ_MAIL_UI_PORT ?? '8025'}/api/v1`;

/**
 * The link in the newest email to `to` received after `since`, read from Mailpit (the e2e worker really sends it).
 * Waits up to 20 s for delivery.
 */
export async function emailLink(to: string, since: Date, linkPath: string): Promise<URL> {
  for (let i = 0; i < 80; i++) {
    const list = (await (await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=5`)).json()) as { messages: { ID: string; Created: string }[] };
    const fresh = list.messages.find((m) => new Date(m.Created) >= since);
    if (fresh) {
      const msg = (await (await fetch(`${MAILPIT}/message/${fresh.ID}`)).json()) as { Text: string };
      const m = new RegExp(`https?://[^\\s"']*${linkPath.replace(/[/?]/g, '\\$&')}\\?token=[\\w.-]+`).exec(msg.Text);
      if (m) return new URL(m[0]);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no email with a ${linkPath} link to ${to} since ${since.toISOString()}`);
}
