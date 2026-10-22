// M2b in the built UI, in Chromium and WebKit (≈ WKWebView): the formatting
// toolbar, renaming from the title, the link trail and switching palettes.
import { expect, test, type Page } from '@playwright/test';
import { openSettings } from './shell';
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
    ((window as unknown as { __liberWrites?: { text: string }[] }).__liberWrites ?? []).map(
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

test('a table from the toolbar: pick a size, fill it with Tab and Enter, click a cell', async ({
  page,
}) => {
  await open(page, 'A');
  await page.locator('.cm-line', { hasText: 'hello world' }).click();
  await page.keyboard.press('End');
  const bar = page.getByRole('toolbar', { name: 'Formatting' });
  await bar.getByRole('button', { name: 'Table' }).click();
  const picker = page.getByRole('dialog', { name: 'Insert a table' });
  await picker.getByRole('button', { name: '2 by 2 table' }).click();
  await page.keyboard.type('Moon');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Days');
  await page.keyboard.press('Enter');
  await page.keyboard.type('13.5');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.type('Dusk');
  // Each Tab and Enter lines the table up; the last word typed isn't padded yet.
  await expect
    .poll(() => writes(page))
    .toContainEqual(
      expect.stringMatching(
        /^hello world\n\n\| Moon \| Days \|\n\| ---- \| ---- \|\n\| Dusk +\| 13\.5 \|\n\nSee/,
      ),
    );
  // Away from it, the table renders; a click on a cell edits that cell.
  await page.locator('.cm-line', { hasText: 'See' }).click();
  const cell = page.locator('.cm-liber-widget td', { hasText: 'Dusk' });
  await expect(cell).toBeVisible();
  await cell.click();
  await page.keyboard.type(' Closing');
  await expect
    .poll(() => writes(page))
    .toContainEqual(expect.stringMatching(/\| Dusk Closing +\| 13\.5 \|/));
});

test('renaming from the title renames the file', async ({ page }) => {
  await open(page, 'A');
  const title = page.getByRole('textbox', { name: 'Page title' });
  await title.fill('Alpha');
  await title.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __liberRenames?: unknown[] }).__liberRenames),
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

test('a plain click on a link in Live Preview opens the page (as in Obsidian)', async ({
  page,
}) => {
  await open(page, 'A');
  await page.locator('.cm-liber-link', { hasText: 'B' }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('B');
  await expect(page.getByRole('button', { name: 'Back to A' })).toBeVisible();
});

test('a table or callout in Live Preview has no blank lines above it', async ({ page }) => {
  await page.addInitScript(installIpcMock, {
    pages: {
      'T.md': 'x\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> [!note] Title\n> body\n\nend\n',
    },
    editorMode: 'livePreview',
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name: 'T' }).click();
  const widgets = page.locator('.cm-liber-widget');
  await expect(widgets).toHaveCount(2);
  for (const w of await widgets.all()) {
    // The rendered block alone: CodeMirror's pre-wrapped whitespace must not
    // turn the renderer's newlines into empty lines.
    const gap = await w.evaluate((el) => {
      const first = el.firstElementChild!.firstElementChild!; // table / callout in the wrapper
      return first.getBoundingClientRect().top - el.getBoundingClientRect().top;
    });
    expect(gap).toBeLessThan(20);
  }
});

test('a palette from Settings applies at once', async ({ page }) => {
  await open(page, 'A');
  await openSettings(page, 'Appearance');
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
