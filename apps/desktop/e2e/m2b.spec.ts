// M2b in the built UI, in Chromium and WebKit (≈ WKWebView): the formatting
// toolbar, renaming from the title, the link trail and switching palettes.
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const PAGES = {
  'A.md': 'hello world\n\nSee [[B]].\n',
  'B.md': '# B\n\nThe second page.\n',
};

async function open(page: Page, name: string, editorMode = 'livePreview') {
  await page.addInitScript(installIpcMock, { pages: { ...PAGES }, editorMode });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue(name);
}

const writes = (page: Page) =>
  page.evaluate(() =>
    ((window as unknown as { __nimwWrites?: { text: string }[] }).__nimwWrites ?? []).map(
      (w) => w.text,
    ),
  );

test('the toolbar formats the word at the cursor and sets a heading', async ({ page }) => {
  await open(page, 'A');
  await page.locator('.cm-line', { hasText: 'hello world' }).click({ position: { x: 30, y: 5 } });
  const bar = page.getByRole('toolbar', { name: 'Formatting' });
  await bar.getByRole('button', { name: 'Bold' }).click();
  await expect(bar.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
  await bar.getByRole('combobox', { name: 'Text style' }).selectOption('2');
  await expect
    .poll(() => writes(page))
    .toContainEqual(expect.stringMatching(/^## \*\*hello\*\* world/));
});

test('renaming from the title renames the file', async ({ page }) => {
  await open(page, 'A');
  const title = page.getByRole('textbox', { name: 'Page title' });
  await title.fill('Alpha');
  await title.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __nimwRenames?: unknown[] }).__nimwRenames),
    )
    .toEqual([{ from: 'A.md', to: 'Alpha.md' }]);
  await expect(title).toHaveValue('Alpha');
});

test('following a link shows the back arrow; ← and ⌘] walk the trail', async ({ page }) => {
  await open(page, 'A', 'split');
  await page.getByRole('region', { name: 'Preview' }).getByRole('link', { name: 'B' }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('B');
  await page.getByRole('button', { name: 'Back to A' }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('A');
  await page.locator('body').press('Control+]');
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('B');
  await page.locator('body').press('Control+[');
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('A');
});

test('a plain click on a link in Live Preview opens the page (as in Obsidian)', async ({ page }) => {
  await open(page, 'A');
  await page.locator('.cm-nimw-link', { hasText: 'B' }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('B');
  await expect(page.getByRole('button', { name: 'Back to A' })).toBeVisible();
});

test('a palette from Settings applies at once', async ({ page }) => {
  await open(page, 'A');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: 'Graphite' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'graphite');
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim(),
      ),
    )
    .toBe('#2448c4');
});
