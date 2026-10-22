// Find in page (⌘F / Ctrl+F in the editor: CodeMirror's search panel, in the
// app's colours; ⌘⇧F stays the vault's Search) and Settings → Files → Show
// file extensions, in the built UI, in Chromium and WebKit (≈ WKWebView).
// LIBER_SHOTS=<dir> saves screenshots of both for review.
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';
import { openSettings } from './shell';

const SHOTS = process.env.LIBER_SHOTS;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

async function open(page: Page, settings: Record<string, unknown> = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages: {
      'Book/Chapter 1.md': '# Chapter 1\n\nThe red wyrm sleeps. Under the hill, a wyrm dreams.\n',
      'Book/notes.txt': 'plain notes\n',
      'Welcome.md': '# Welcome\n\nHello.\n',
    },
    folders: ['Book'],
    editorMode: 'livePreview',
    remoteCover: false,
    settings,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  return errors;
}

const findField = (page: Page) => page.getByRole('textbox', { name: 'Find in page' });
const selectedMatch = (page: Page) => page.locator('.cm-searchMatch-selected');

async function openChapter(page: Page) {
  await page.getByRole('treeitem', { name: 'Book', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Chapter 1', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Chapter 1');
  await page.locator('.cm-line', { hasText: 'red wyrm' }).click();
}

test('find in page: ⌘F finds, steps through matches, replaces one; Escape gives the text back', async ({
  page,
}) => {
  const errors = await open(page);
  await openChapter(page);
  await page.keyboard.press('ControlOrMeta+F');
  await expect(findField(page)).toBeFocused();
  // Not the vault's Search.
  await expect(page.getByRole('combobox', { name: 'Search the vault' })).toBeHidden();

  await page.keyboard.type('wyrm');
  await expect(page.locator('.cm-searchMatch')).toHaveCount(2);
  await page.keyboard.press('Enter');
  await expect(selectedMatch(page)).toHaveCount(1);
  const first = (await selectedMatch(page).boundingBox())!;
  await page.keyboard.press('Enter');
  const second = (await selectedMatch(page).boundingBox())!;
  expect(second.x).not.toBe(first.x);
  await page.keyboard.press('Shift+Enter');
  expect((await selectedMatch(page).boundingBox())!.x).toBe(first.x);
  await page.keyboard.press('F3');
  expect((await selectedMatch(page).boundingBox())!.x).toBe(second.x);
  await shot(page, 'find-light');

  // Replace the current match (the second), then only one wyrm is left.
  await page.getByRole('textbox', { name: 'Replace with' }).fill('drake');
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('a drake dreams');
  await expect(page.locator('.cm-content')).toContainText('The red wyrm sleeps');
  await expect(page.locator('.cm-searchMatch')).toHaveCount(1);

  await findField(page).focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.cm-search')).toHaveCount(0);
  await expect(page.locator('.cm-content')).toBeFocused();

  // ⌘⇧F is still the vault's Search, from the editor too.
  await page.keyboard.press('ControlOrMeta+Shift+F');
  await expect(page.getByRole('combobox', { name: 'Search the vault' })).toBeFocused();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('find in page in dark, and ⌘F outside the editor still opens Search', async ({ page }) => {
  const errors = await open(page, { theme: 'dark' });
  await openChapter(page);
  await page.keyboard.press('ControlOrMeta+F');
  await expect(findField(page)).toBeFocused();
  await page.keyboard.type('wyrm');
  await page.keyboard.press('Enter');
  await expect(selectedMatch(page)).toHaveCount(1);
  // The panel takes the app's surface, not CodeMirror's grey.
  const bg = await page
    .locator('.cm-panels')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  const surface = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim(),
  );
  expect(bg).not.toBe('rgb(51, 51, 56)');
  expect(bg).not.toBe('rgb(245, 245, 245)');
  expect(surface).not.toBe('');
  await shot(page, 'find-dark');
  await page.keyboard.press('Escape');

  await page.keyboard.press('ControlOrMeta+2');
  await page.keyboard.press('ControlOrMeta+F');
  await expect(page.getByRole('combobox', { name: 'Search the vault' })).toBeFocused();
  expect(errors).toEqual([]);
});

test('Show file extensions: off by default, on shows them in the tree, rename keeps the .md', async ({
  page,
}) => {
  const errors = await open(page);
  await page.getByRole('treeitem', { name: 'Book', exact: true }).click();
  const tree = page.getByRole('tree', { name: 'Files' });
  await expect(tree.getByRole('treeitem', { name: 'Chapter 1', exact: true })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'notes.txt', exact: true })).toBeVisible();

  await openSettings(page, 'Files and quick notes');
  const box = page.getByRole('checkbox', { name: 'Show file extensions' });
  await expect(box).not.toBeChecked();
  await box.check();
  await page.keyboard.press('Escape');

  await expect(tree.getByRole('treeitem', { name: 'Chapter 1.md', exact: true })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'Welcome.md', exact: true })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'notes.txt', exact: true })).toBeVisible();
  await shot(page, 'tree-extensions');

  // The rename field holds the name; the .md sits after it and stays.
  await tree.getByRole('treeitem', { name: 'Chapter 1.md', exact: true }).focus();
  await page.keyboard.press('F2');
  const field = page.getByRole('textbox', { name: 'Rename' });
  await expect(field).toHaveValue('Chapter 1');
  await expect(page.locator('[data-rename-ext]')).toHaveText('.md');
  await field.fill('Opening');
  await page.keyboard.press('Enter');
  await expect(tree.getByRole('treeitem', { name: 'Opening.md', exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => (window as { __liberRenames?: unknown }).__liberRenames),
  ).toEqual([{ from: 'Book/Chapter 1.md', to: 'Book/Opening.md' }]);

  // Off again: as before.
  await openSettings(page, 'Files and quick notes');
  await page.getByRole('checkbox', { name: 'Show file extensions' }).uncheck();
  await page.keyboard.press('Escape');
  await expect(tree.getByRole('treeitem', { name: 'Opening', exact: true })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'notes.txt', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
