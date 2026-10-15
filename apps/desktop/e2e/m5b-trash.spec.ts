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

test('Archive hides a page; the Archived view unarchives it', async ({ page }) => {
  const errors = await open(page);
  await page.getByRole('treeitem', { name: 'A', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(page.getByRole('treeitem', { name: 'A', exact: true })).toBeHidden();

  await page.getByRole('button', { name: 'Archived, 1 item' }).click();
  const list = page.getByRole('list', { name: 'Archived' });
  await list.getByRole('button', { name: 'Unarchive A' }).click();
  await expect(page.getByText('Nothing is archived.')).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'A', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
