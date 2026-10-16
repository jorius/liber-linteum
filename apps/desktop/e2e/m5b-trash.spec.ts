// M5b §5: delete moves into the vault's Trash (restorable from its view),
// and Archive hides a page until it's unarchived — in the built UI, in
// Chromium and WebKit (≈ WKWebView).
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages: { 'A.md': '# A\n\nText.\n', 'B.md': '# B\n\nMore.\n' },
    editorMode: 'livePreview',
    settings: {},
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await expect(page.getByRole('treeitem', { name: 'B', exact: true })).toBeVisible();
  return errors;
}

test('delete moves to the Trash, and Restore brings it back', async ({ page }) => {
  const errors = await open(page);
  await page.getByRole('treeitem', { name: 'B', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Move “B” to Trash?' });
  await confirm.getByRole('button', { name: 'Move to Trash' }).click();
  await expect(page.getByRole('treeitem', { name: 'B', exact: true })).toBeHidden();

  await page.getByRole('button', { name: 'Trash, 1 item' }).click();
  const list = page.getByRole('list', { name: 'Trash' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await list.getByRole('button', { name: 'Restore B' }).click();
  await expect(page.getByText('The Trash is empty.')).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'B', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Trash, 0 items' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Archive hides a page; Archived opens like a folder, read-only, and unarchives it', async ({
  page,
}) => {
  const errors = await open(page);
  await page.getByRole('treeitem', { name: 'A', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  const files = page.getByRole('tree', { name: 'Files' });
  await expect(files.getByRole('treeitem', { name: 'A', exact: true })).toBeHidden();

  // Archived opens on its own, like a folder something moved into.
  const toggle = page.getByRole('button', { name: 'Archived, 1 item' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const archived = page.getByRole('tree', { name: 'Archived' });
  await archived.getByRole('treeitem', { name: 'A', exact: true }).click();
  // M5b round 2: archived pages are read-only.
  await expect(page.getByText('This page is archived. Unarchive it to edit it.')).toBeVisible();
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveAttribute('readonly', '');

  await archived.getByRole('treeitem', { name: 'A', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Unarchive' }).click();
  await expect(files.getByRole('treeitem', { name: 'A', exact: true })).toBeVisible();
  await expect(page.getByRole('tree', { name: 'Archived' })).toBeHidden();
  expect(errors).toEqual([]);
});
