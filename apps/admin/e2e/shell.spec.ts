// ✅ Task 2.1: every nav item reachable at 1280×720, 1024×600 and 200 % zoom (by scroll and by keyboard); axe passes.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

const OWNER = { email: 'owner@e2e.artq.in', password: 'e2e-owner-passphrase' };
const STAFF = { email: 'staff@e2e.artq.in', password: 'e2e-staff-passphrase' };
const ALL = ['Dashboard', 'Orders', 'Customers', 'Coupons', 'Shipping Rates', 'Products', 'Restock Requests', 'Product Types', 'Categories', 'Techniques',
  'Inventory', 'Returns & Refunds', 'COD Remittances', 'Payment Exceptions', 'Jobs & Webhooks', 'Imports', 'Media', 'CMS & Messages',
  'Staff & Permissions', 'Settings', 'Audit Logs'];

async function login(page: Page, who: { email: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

async function axeClean(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}

/**
 * A user with a mouse wheel / touchpad can reach every item: wheel over the list until each link is fully visible.
 * (Programmatic scrollIntoView would also move an `overflow: hidden` list, so it would not prove user scrolling.)
 */
async function everyItemReachableByScroll(page: Page, list: Locator) {
  const links = list.getByRole('link');
  await expect(links).toHaveText(ALL);
  const box = (await list.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 200));
  for (let i = 0; i < ALL.length; i++) {
    const link = links.nth(i);
    for (let step = 0; step < 40 && !(await isFullyVisible(page, link)); step++) await page.mouse.wheel(0, 120);
    await expect(link).toBeInViewport({ ratio: 1 });
  }
  // and back to the top the same way
  for (let step = 0; step < 40 && !(await isFullyVisible(page, links.first())); step++) await page.mouse.wheel(0, -120);
  await expect(links.first()).toBeInViewport({ ratio: 1 });
}

async function isFullyVisible(page: Page, el: Locator): Promise<boolean> {
  const b = await el.boundingBox();
  const vp = page.viewportSize()!;
  return !!b && b.y >= 0 && b.y + b.height <= vp.height && b.x >= 0 && b.x + b.width <= vp.width;
}

/** Tabbing from the first item reaches the last one, which the browser scrolls into view. */
async function everyItemReachableByKeyboard(page: Page, list: Locator) {
  const links = list.getByRole('link');
  await links.first().focus();
  for (let i = 1; i < ALL.length; i++) {
    await page.keyboard.press('Tab');
    await expect(links.nth(i)).toBeFocused();
    await expect(links.nth(i)).toBeInViewport();
  }
}

const desktop = [{ name: '1280×720', width: 1280, height: 720 }, { name: '1024×600', width: 1024, height: 600 }];

for (const vp of desktop) {
  test.describe(`desktop ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('sidebar: every module reachable by scroll and keyboard, opens its page, and the page passes axe', async ({ page }) => {
      await login(page, OWNER);
      const list = page.getByTestId('sidebar-scroll');
      await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
      expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);           // the list really overflows here
      await everyItemReachableByScroll(page, list);
      await everyItemReachableByKeyboard(page, list);
      expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);   // only the sidebar scrolled
      for (const label of ALL) {
        const link = list.getByRole('link', { name: label, exact: true });
        await link.scrollIntoViewIfNeeded();
        await link.click();
        await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
        await expect(link).toHaveAttribute('aria-current', 'page');
      }
      await axeClean(page);
      await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
      await axeClean(page);
    });
  });
}

test.describe('200 % zoom (1280×720 window at 2× = 640×360 CSS px)', () => {
  test.use({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 2 });

  test('drawer: opens from the menu, every module reachable by scroll and keyboard, Esc closes and returns focus, axe passes', async ({ page }) => {
    await login(page, OWNER);
    await expect(page.getByTestId('sidebar')).toBeHidden();
    const menu = page.getByRole('button', { name: 'Open navigation' });
    await menu.click();
    const list = page.getByTestId('drawer-scroll');
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await everyItemReachableByScroll(page, list);
    await everyItemReachableByKeyboard(page, list);
    await axeClean(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('drawer')).toBeHidden();
    await expect(menu).toBeFocused();
    for (const label of ['Techniques', 'Audit Logs']) {
      await menu.click();
      const link = page.getByTestId('drawer-scroll').getByRole('link', { name: label, exact: true });
      await link.scrollIntoViewIfNeeded();
      await link.click();
      await expect(page.getByTestId('drawer')).toBeHidden();
      await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
    }
    await axeClean(page);
  });
});

test.describe('roles and session', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('STAFF sees only the modules its role allows; other modules show "No access"', async ({ page }) => {
    await login(page, STAFF);
    await expect(page.getByTestId('sidebar-scroll').getByRole('link')).toHaveText(['Dashboard', 'Orders', 'Customers', 'Products', 'Restock Requests', 'Inventory', 'Returns & Refunds', 'Imports']);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible();
  });

  test('the session survives a reload (refresh cookie) and ends on logout; a wrong password is explained', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
    await axeClean(page);
    await login(page, OWNER);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.getByRole('button', { name: /Log out/ }).click();
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
    await page.goto('/dashboard');
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
  });

  test('Audit Logs lists the logins of this run through the real API', async ({ page }) => {
    await login(page, OWNER);
    await page.goto('/audit-logs?action=admin.login');
    await expect(page.getByRole('table', { name: 'Audit log entries' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'admin.login' }).first()).toBeVisible();
    await expect(page.getByText(/Page 1 of \d+ · \d+ total/)).toBeVisible();
    await axeClean(page);
  });
});
