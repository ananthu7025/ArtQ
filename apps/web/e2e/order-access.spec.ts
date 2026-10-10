// ✅ Task 5.7 / AT-12 in a real browser against the real API and worker: a guest places a COD order; the order email
// (delivered to Mailpit) links to the order page, which is read-only (address masked, no actions) until the guest
// confirms the order's email with a one-time code; then they can cancel it. The access is for that order only: a
// second guest order opened without its link stays closed, and an edited link is refused.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const API_DIR = join(import.meta.dirname, '..', '..', 'api');
const E2E_REDIS_URL = `redis://localhost:${process.env.ARTQ_REDIS_PORT ?? '56379'}/5`;
const MAILPIT = `http://localhost:${process.env.ARTQ_MAIL_UI_PORT ?? '8025'}/api/v1`;
test.use({ viewport: { width: 1280, height: 900 } });
test.beforeAll(() => {
  execFileSync('pnpm', ['--dir', API_DIR, 'exec', 'tsx', 'scripts/e2e-reset-rate-limits.ts'], { env: { ...process.env, E2E_REDIS_URL }, stdio: 'pipe' });
});

/** The text of the newest email to `to` whose subject matches. */
async function mail(to: string, subject: RegExp): Promise<string> {
  let text: string | null = null;
  await expect.poll(async () => {
    const found = (await (await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json()) as { messages: { ID: string; Subject: string }[] };
    const m = found.messages.find((x) => subject.test(x.Subject));
    if (!m) return null;
    text = ((await (await fetch(`${MAILPIT}/message/${m.ID}`)).json()) as { Text: string }).Text;
    return text;
  }, { timeout: 20_000, message: `no "${subject}" email to ${to}` }).not.toBeNull();
  return text!;
}
async function axeClean(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}
async function placeCodOrder(page: Page, email: string): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: /^Add .+ to cart$/ }).first().click();
  await page.getByRole('dialog', { name: 'Added to your cart' }).getByRole('link', { name: 'Checkout' }).click();
  const main = page.getByRole('main');
  await main.getByLabel('Email', { exact: true }).fill(email);
  await main.getByLabel('Mobile number').fill('98470 12345');
  await main.getByLabel('Full name').fill('Hema Rajan');
  await main.getByLabel('Phone for delivery').fill('9847012345');
  await main.getByLabel('Pincode').fill('682011');
  await expect(main.getByLabel('City / town')).toHaveValue('Ernakulam');
  await main.getByLabel('House / flat, building and street').fill('12 Rose Villa');
  await expect(main.getByText(/^We deliver here/)).toBeVisible();
  await main.getByLabel(/I agree to the/).check();
  await main.getByRole('button', { name: /^Place order · ₹/ }).click();
  await expect(page).toHaveURL(/\/checkout\/success\/AQ\d+$/);
  return page.url().split('/').at(-1)!;
}

test('AT-12: tracking link read-only; the email code opens that order only; then the guest cancels it', async ({ page, baseURL }) => {
  const email = `e2e-track-${Date.now().toString(36)}@example.com`;
  const orderNumber = await placeCodOrder(page, email);
  const placed = await mail(email, /^Order AQ\d+ placed$/);
  const link = new URL(/https?:\/\/\S+\/track\/AQ\d+\?token=[A-Za-z0-9_-]+/.exec(placed)![0]);
  expect(link.pathname).toBe(`/track/${orderNumber}`);

  // Read-only: masked phone, no actions, the verify panel.
  await page.goto(`${baseURL}${link.pathname}${link.search}`);
  await expect(page.getByRole('heading', { name: `Order ${orderNumber}` })).toBeVisible();
  await expect(page.getByText(/^Phone \+?\*{6,}2345$/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
  await axeClean(page);
  // An edited link is refused.
  await page.goto(`${baseURL}${link.pathname}?token=${link.searchParams.get('token')!.slice(0, -3)}abc`);
  await expect(page.getByRole('heading', { name: 'We couldn’t open this order' })).toBeVisible();

  await page.goto(`${baseURL}${link.pathname}${link.search}`);
  await page.getByLabel('Email used for the order').fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  const code = /\b(\d{6})\b/.exec(await mail(email, /is your ArtQ code$/))![1]!;
  await page.getByLabel('6-digit code').fill(code === '000000' ? '111111' : '000000');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByLabel('6-digit code')).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('heading', { name: 'Manage this order' })).toHaveCount(0);
  await expect(page.getByText(/^Phone (\+91)?9847012345$/)).toBeVisible();

  // The access is for this order only: a second order opened without its link stays closed.
  const other = await placeCodOrder(page, `e2e-track2-${Date.now().toString(36)}@example.com`);
  await page.goto(`${baseURL}/track/${other}`);
  await expect(page.getByRole('heading', { name: 'We couldn’t open this order' })).toBeVisible();

  // Back on the first order (the cookie still holds): cancel it.
  await page.goto(`${baseURL}/track/${orderNumber}`);
  await page.getByRole('button', { name: 'Cancel order' }).click();
  const panel = page.getByRole('region', { name: 'Cancel this order?' });
  await expect(panel).toContainText('You won’t be charged.');
  await axeClean(page);
  await panel.getByRole('button', { name: 'Cancel order' }).click();
  await expect(page.getByLabel('Order status')).toHaveText('Cancelled');
});
