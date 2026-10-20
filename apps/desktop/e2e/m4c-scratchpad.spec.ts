// M4c: quick notes in the built UI, in Chromium and WebKit (≈ WKWebView).
// From the Welcome screen a quick note asks where quick notes live, opens the
// global Scratchpad and takes its name from its first line; with a vault
// open, ⌘⇧N puts it in the vault's scratch folder, pinned in the explorer.
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

async function start(page: Page, pages: Record<string, string>) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages,
    editorMode: 'livePreview',
    settings: {},
    remoteCover: false,
  });
  await page.goto('/');
  return errors;
}

test('a quick note from the Welcome screen is named after its first line', async ({ page }) => {
  const errors = await start(page, {});
  await page.getByRole('button', { name: 'Quick note', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Where should quick notes live?' });
  await expect(dialog.getByText('/Users/e2e/Documents/Liber Linteum/Scratchpad')).toBeVisible();
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();

  // The Scratchpad is open as "Quick notes", the new note with the cursor in it.
  await expect(page.getByRole('complementary', { name: /Quick notes/ })).toBeVisible();
  const editor = page.locator('.cm-content');
  await expect(editor).toBeFocused();
  await page.keyboard.type('# Groceries');
  await page.keyboard.press('Enter');
  await page.keyboard.type('milk');

  await expect(page.getByRole('treeitem', { name: 'Groceries', exact: true })).toBeVisible({
    timeout: 6000,
  });
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Groceries');
  // Typing went on in the same note.
  await expect(editor).toContainText('milk');
  expect(errors).toEqual([]);
});

test('⌘⇧N in an open vault: a note in its scratch folder, pinned first', async ({ page }) => {
  const errors = await start(page, { 'Art/rex.md': '# Rex\n', 'Welcome.md': 'Hi\n' });
  await page.getByRole('button', { name: /^vault/ }).click();
  await expect(page.getByRole('treeitem', { name: 'Welcome', exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+N');
  const pinned = page.getByRole('treeitem').first();
  await expect(pinned).toHaveAccessibleName('Scratchpad, quick notes, 1 note');
  await expect(page.locator('.cm-content')).toBeFocused();
  await page.keyboard.type('Call the dentist');
  await expect(page.getByRole('treeitem', { name: 'Call the dentist', exact: true })).toBeVisible({
    timeout: 6000,
  });
  // No folder was made by ⌘⇧N (it was New folder before M4c).
  await expect(page.getByRole('treeitem', { name: 'Untitled' })).toHaveCount(0);
  expect(errors).toEqual([]);
});
