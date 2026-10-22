// Go to line (Ctrl+G on every platform) and the cursor position beside the
// word count, in the built UI, in Chromium and WebKit (≈ WKWebView).
// LIBER_SHOTS=<dir> saves screenshots for review.
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const SHOTS = process.env.LIBER_SHOTS;

const TEXT =
  '---\ntags: [lore]\n---\n# Alpha\n\n' +
  Array.from({ length: 80 }, (_, i) => `Line number ${i + 6} of the page.`).join('\n') +
  '\n';

async function open(page: Page, editorMode = 'source') {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages: { 'A.md': TEXT, 'B.md': '# Bravo\n\nshort\n' },
    editorMode,
    remoteCover: false,
    settings: {},
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name: 'A', exact: true }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  return errors;
}

const field = (page: Page) => page.locator('.cm-liber-goto input');

test('Ctrl+G: 42, 42:7, +5 / -5 jump and scroll; Escape gives the text back', async ({ page }) => {
  const errors = await open(page);
  await page.locator('.cm-line', { hasText: 'Line number 6 of' }).click();
  await page.keyboard.press('Control+G');
  await expect(field(page)).toBeFocused();
  await expect(field(page)).toHaveValue('6');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'goto-line.png') });

  // Line 70 is far below: it is scrolled into view, the cursor at its start.
  await field(page).fill('70');
  await page.keyboard.press('Enter');
  await expect(page.locator('.cm-liber-goto')).toHaveCount(0);
  await expect(page.locator('.cm-content')).toBeFocused();
  await expect(page.locator('.cm-line', { hasText: 'Line number 70 of' })).toBeInViewport();
  await page.keyboard.type('>');
  await expect(page.locator('.cm-line', { hasText: 'Line number 70 of' })).toHaveText(
    '>Line number 70 of the page.',
  );

  // line:column, from 1.
  await page.keyboard.press('Control+G');
  await field(page).fill('10:6');
  await page.keyboard.press('Enter');
  await page.keyboard.type('|');
  await expect(page.locator('.cm-line', { hasText: 'number 10 of' })).toHaveText(
    'Line |number 10 of the page.',
  );

  // Relative to the cursor's line.
  await page.keyboard.press('Control+G');
  await field(page).fill('+5');
  await page.keyboard.press('Enter');
  await page.keyboard.type('+');
  await expect(page.locator('.cm-line', { hasText: 'number 15 of' })).toHaveText(
    '+Line number 15 of the page.',
  );
  await page.keyboard.press('Control+G');
  await field(page).fill('-3');
  await page.keyboard.press('Enter');
  await page.keyboard.type('-');
  await expect(page.locator('.cm-line', { hasText: 'number 12 of' })).toHaveText(
    '-Line number 12 of the page.',
  );

  // Frontmatter lines count: line 1 is the opening ---.
  await page.keyboard.press('Control+G');
  await field(page).fill('4');
  await page.keyboard.press('Enter');
  await page.keyboard.type('!');
  await expect(page.locator('.cm-line', { hasText: 'Alpha' })).toHaveText('!# Alpha');

  // Escape closes it without moving.
  await page.keyboard.press('Control+G');
  await expect(field(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.cm-liber-goto')).toHaveCount(0);
  await expect(page.locator('.cm-content')).toBeFocused();
  expect(errors).toEqual([]);
});

test('Ctrl+G in Live Preview, from the sidebar too', async ({ page }) => {
  const errors = await open(page, 'livePreview');
  await page.getByRole('treeitem', { name: 'A', exact: true }).focus();
  await page.keyboard.press('Control+G');
  await expect(field(page)).toBeFocused();
  await field(page).fill('40');
  await page.keyboard.press('Enter');
  await expect(page.locator('.cm-line', { hasText: 'Line number 40 of' })).toBeInViewport();
  expect(errors).toEqual([]);
});

const position = (page: Page) => page.locator('[data-cursor-position]');

test('the cursor position beside the word count: hidden, then Ln/Col and the selection; a click opens Go to line', async ({
  page,
}) => {
  const errors = await open(page);
  // Nobody has placed a cursor yet.
  await expect(position(page)).toHaveCount(0);
  await page.locator('.cm-line', { hasText: 'Line number 8 of' }).click();
  await page.keyboard.press('Home');
  await expect(position(page)).toHaveText('Ln 8, Col 1');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(position(page)).toHaveText('Ln 8, Col 3');
  // "Line number 8 of the page." less its first two characters.
  await page.keyboard.press('Shift+End');
  await expect(position(page)).toHaveText('Ln 8, Col 27 · 24 selected');
  // Not a live region: it would talk on every keystroke.
  await expect(position(page)).not.toHaveAttribute('aria-live');
  expect(await position(page).evaluate((el) => el.closest('[aria-live]'))).toBeNull();

  await position(page).click();
  await expect(field(page)).toBeFocused();
  await expect(field(page)).toHaveValue('8');
  await field(page).fill('20:5');
  await page.keyboard.press('Enter');
  await expect(position(page)).toHaveText('Ln 20, Col 5');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'cursor-position.png') });
  expect(errors).toEqual([]);
});

test('the cursor position follows Split too', async ({ page }) => {
  const errors = await open(page, 'split');
  await page.locator('.cm-line', { hasText: 'Line number 7 of' }).click();
  await page.keyboard.press('End');
  await expect(position(page)).toHaveText('Ln 7, Col 27');
  expect(errors).toEqual([]);
});
