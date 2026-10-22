// Go to line (Ctrl+G on every platform) in the built UI, in Chromium and
// WebKit (≈ WKWebView). LIBER_SHOTS=<dir> saves a screenshot for review.
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
