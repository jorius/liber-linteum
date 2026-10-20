// Round 3 §2: the sidebar's width (drag, remembered), whole names when there
// is room, glyphs that keep their size, and the ★ ☺ 🗑 row actions — in the
// built UI, in Chromium and WebKit (≈ WKWebView).
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const LONG = 'Web Application Pentesting';

async function open(page: Page, settings: Record<string, unknown> = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages: { [`${LONG}.md`]: '# W\n', 'Linux.md': '# L\n' },
    folders: ['Hardware & Embedded'],
    editorMode: 'livePreview',
    settings,
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await expect(page.getByRole('treeitem', { name: 'Linux' })).toBeVisible();
  return errors;
}

const sideWidth = (page: Page) =>
  page.getByRole('complementary').evaluate((el) => el.getBoundingClientRect().width);

test('dragging the edge resizes the sidebar and the width is saved', async ({ page }) => {
  const errors = await open(page);
  expect(Math.round(await sideWidth(page))).toBe(270);
  const edge = page.getByRole('separator', { name: 'Resize the sidebar' });
  await expect(edge).toBeVisible();
  const box = (await edge.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // The edge follows the pointer before it's released.
  await page.mouse.move(x + 120, y, { steps: 4 });
  await expect(edge).toHaveAttribute('aria-valuenow', '390');
  await page.mouse.up();
  await expect.poll(async () => Math.round(await sideWidth(page))).toBeGreaterThan(370);
  await expect(edge).toHaveAttribute('aria-valuenow', '390');
  const saved = await page.evaluate(() =>
    (
      window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string) => Promise<unknown> } }
    ).__TAURI_INTERNALS__.invoke('settings_get'),
  );
  expect((saved as { settings: { sidebarWidth: number } }).settings.sidebarWidth).toBeGreaterThan(
    370,
  );
  expect(errors).toEqual([]);
});

test('a saved width is used; names are whole when they fit; glyphs keep their size', async ({
  page,
}) => {
  const errors = await open(page, { sidebarWidth: 420 });
  expect(Math.round(await sideWidth(page))).toBe(420);
  // Away from the pointer, the hidden actions take no room: the long name fits.
  await page.mouse.move(900, 500);
  const label = page
    .getByRole('treeitem', { name: LONG })
    .locator('span')
    .filter({ hasText: LONG });
  expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  // Every row's glyph is the same width, however long its name.
  const widths = await page
    .getByRole('treeitem')
    .evaluateAll((rows) => rows.map((r) => r.querySelector('svg')!.getBoundingClientRect().width));
  expect(new Set(widths.map(Math.round)).size).toBe(1);
  expect(errors).toEqual([]);
});

test('a row shows ★ ☺ 🗑 on hover, no "…"; right-click opens its menu', async ({ page }) => {
  const errors = await open(page);
  const row = page.getByRole('treeitem', { name: 'Linux' });
  await row.hover();
  await expect(row.getByRole('button')).toHaveText(['', '', '']);
  await expect(row.getByRole('button', { name: 'Linux in Favorites' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Icon for Linux' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Move Linux to Trash' })).toBeVisible();
  await row.getByRole('button', { name: 'Linux in Favorites' }).click();
  await expect(row.getByRole('button', { name: 'Linux in Favorites' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await row.click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'Actions for Linux' })).toBeVisible();
  expect(errors).toEqual([]);
});
