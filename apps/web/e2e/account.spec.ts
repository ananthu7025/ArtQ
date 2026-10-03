// ✅ Task 4.2 in a real browser against the real API: signup with the code from the delivered email (Mailpit), the guest cart and wishlist joining
// the account, addresses with pincode autofill, and AT-11: three tabs reloading together stay signed in (one refresh
// at a time, server grace), a logout or login in one tab reaches the others, and a stolen refresh token replayed after
// the grace window ends the session.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const API_DIR = join(import.meta.dirname, '..', '..', 'api');
const E2E_REDIS_URL = `redis://localhost:${process.env.ARTQ_REDIS_PORT ?? '56379'}/5`;
const API = 'http://localhost:4001';
const EMAIL = `e2e-${Date.now().toString(36)}@example.com`;
const PASSWORD = 'resin-art-2026';

test.beforeAll(() => {
  execFileSync('pnpm', ['--dir', API_DIR, 'exec', 'tsx', 'scripts/e2e-reset-rate-limits.ts'], { env: { ...process.env, E2E_REDIS_URL }, stdio: 'pipe' });
});
/** The code in the latest email delivered to `to`, read from Mailpit (the local mail catcher the e2e worker sends to). */
const MAILPIT = `http://localhost:${process.env.ARTQ_MAIL_UI_PORT ?? '8025'}/api/v1`;
async function lastCode(to: string): Promise<string> {
  let code: string | null = null;
  await expect.poll(async () => {
    const found = (await (await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json()) as { messages: { ID: string }[] };
    if (!found.messages[0]) return null;
    const msg = (await (await fetch(`${MAILPIT}/message/${found.messages[0].ID}`)).json()) as { Text: string };
    code = /\b(\d{6})\b/.exec(msg.Text)?.[1] ?? null;
    return code;
  }, { timeout: 15_000, message: `no code emailed to ${to}` }).not.toBeNull();
  return code!;
}
async function axeClean(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}
const header = (page: Page) => page.getByRole('banner');
const signedInAs = (page: Page, first: string) => expect(header(page).getByRole('link', { name: 'Your account' })).toHaveText(first);
const signedOut = (page: Page) => expect(header(page).getByRole('link', { name: 'Login / Sign up' })).toBeVisible();
const cartCount = (page: Page) => header(page).getByRole('link', { name: /^Cart, \d+ items?$/ });
async function logIn(page: Page) {
  await page.goto('/login');
  const panel = page.getByRole('tabpanel', { name: 'Password' });
  await panel.getByLabel('Email', { exact: true }).fill(EMAIL);
  await panel.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await panel.getByRole('button', { name: 'Log in' }).click();
  await signedInAs(page, 'Devika');
}
const wishCount = (page: Page) => header(page).getByRole('link', { name: /^Wishlist, \d+ items?$/ });

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1440, height: 900 } });

test('signup: the guest cart and wishlist join the new account; the form shows errors under the fields; axe clean', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Add .+ to cart$/ }).first().click();
  await expect(cartCount(page)).toHaveAccessibleName('Cart, 1 item');
  await page.getByRole('button', { name: /^Save .+ to wishlist$/ }).first().click();
  await expect(wishCount(page)).toHaveAccessibleName('Wishlist, 1 item');

  await header(page).getByRole('link', { name: 'Login / Sign up' }).click();
  await page.getByRole('link', { name: 'Create an account' }).click();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByLabel('Full name')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Enter a name')).toBeVisible();
  await axeClean(page);
  await page.getByLabel('Full name').fill('Devika Nair');
  await page.getByRole('main').getByLabel('Email', { exact: true }).fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/signup\/verify$/);
  await page.getByLabel('6-digit code').fill(await lastCode(EMAIL));
  await page.getByRole('button', { name: 'Confirm email' }).click();

  await expect(page).toHaveURL(/\/account$/);
  await signedInAs(page, 'Devika');
  await expect(cartCount(page)).toHaveAccessibleName('Cart, 1 item');          // the guest cart is now the account's
  await expect(wishCount(page)).toHaveAccessibleName('Wishlist, 1 item');      // and the wishlist joined it
  await expect.poll(() => page.evaluate(() => localStorage.getItem('aq_wishlist'))).toBeNull();
  await axeClean(page);
});

test('addresses: the pincode fills in the state and city; a mismatch shows under the pincode', async ({ page }) => {
  await logIn(page);
  await page.goto('/account/addresses');
  await page.getByRole('button', { name: 'Add an address' }).click();
  await page.getByLabel('Full name').fill('Devika Nair');
  await page.getByLabel('Mobile number').fill('9847012345');
  await page.getByLabel('Pincode').fill('682011');
  await expect(page.getByLabel('State')).toHaveValue(/\d+/);
  await expect(page.getByLabel('State').locator('option:checked')).toHaveText('Kerala');
  await expect(page.getByLabel('City / town')).toHaveValue('Ernakulam');
  await page.getByLabel('House / flat, building and street').fill('12 MG Road');
  await page.getByLabel('State').selectOption({ label: 'Karnataka' });
  await page.getByRole('button', { name: 'Add address' }).click();
  await expect(page.getByLabel('Pincode')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('This pincode is in Kerala')).toBeVisible();
  await page.getByLabel('State').selectOption({ label: 'Kerala' });
  await page.getByRole('button', { name: 'Add address' }).click();
  await expect(page.getByText('Default', { exact: true })).toBeVisible();
  await expect(page.getByText('Ernakulam, Kerala 682011')).toBeVisible();
  await axeClean(page);
});

test('AT-11: three tabs reloading together stay signed in; logout and login in one tab reach the others', async ({ context }) => {
  const tabs = await Promise.all([0, 1, 2].map(() => context.newPage()));
  const refreshes: string[] = [];
  for (const t of tabs) t.on('response', (r) => { if (r.url().endsWith('/v1/auth/refresh')) refreshes.push(`${r.status()}`); });
  await logIn(tabs[0]!);
  await Promise.all([tabs[1]!.goto('/account'), tabs[2]!.goto('/wishlist')]);
  for (const t of tabs.slice(1)) await signedInAs(t, 'Devika');

  for (let round = 0; round < 2; round++) {
    refreshes.length = 0;
    await Promise.all(tabs.map((t) => t.reload()));
    for (const t of tabs) await signedInAs(t, 'Devika');
    expect(refreshes.every((s) => s === '200')).toBe(true);                     // no refresh was refused (no false reuse)
  }
  await expect(tabs[1]!.getByRole('heading', { name: 'Profile & security' })).toBeVisible();

  // Logout in one tab: the others drop the session at once, without a reload.
  await tabs[1]!.getByRole('button', { name: 'Log out' }).click();
  for (const t of tabs) await signedOut(t);
  await expect(tabs[1]!).toHaveURL(/\/$/);
  // Login in one tab: the others pick it up.
  await logIn(tabs[0]!);
  for (const t of tabs) await signedInAs(t, 'Devika');
});

test('AT-11: a refresh token replayed after the grace window ends the session in every tab', async ({ context, playwright }) => {
  test.setTimeout(120_000);
  const tab = await context.newPage();
  const other = await context.newPage();
  await logIn(tab);
  const stolen = (await context.cookies(`${API}/v1/auth/refresh`)).find((c) => c.name === 'aq_rt_dev')!;
  expect(stolen).toBeTruthy();
  await tab.reload();                                                         // rotates the refresh token
  await signedInAs(tab, 'Devika');
  await other.goto('/account');
  await signedInAs(other, 'Devika');

  await tab.waitForTimeout(31_000);                                           // past the 30 s grace window
  const thief = await playwright.request.newContext();
  const replay = await thief.post(`${API}/v1/auth/refresh`, { headers: { Origin: new URL(tab.url()).origin, Cookie: `aq_rt_dev=${stolen.value}` }, data: {} });
  expect(replay.status()).toBe(401);
  await thief.dispose();

  await tab.reload();                                                         // the whole session was revoked
  await signedOut(tab);
  await other.reload();
  await signedOut(other);
});
