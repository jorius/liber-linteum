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
  const list = page.getByRole('list', { name: 'Today' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await list.getByRole('button', { name: 'Restore B' }).click();
  await expect(page.getByRole('heading', { name: 'The Trash is empty' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'B', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Trash, 0 items' })).toBeVisible();
  expect(errors).toEqual([]);
});

// M5b round 2: the Trash view's filter, sort and selection bar.
test('the Trash filters, sorts, and restores or deletes a selection', async ({ page }) => {
  const errors = await open(page);
  for (const name of ['A', 'B']) {
    await page.getByRole('treeitem', { name, exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page
      .getByRole('dialog', { name: `Move “${name}” to Trash?` })
      .getByRole('button', { name: 'Move to Trash' })
      .click();
  }
  await page.getByRole('button', { name: 'Trash, 2 items' }).click();
  const today = page.getByRole('list', { name: 'Today' });
  // Newest first by default: B went last.
  await expect(today.locator('[data-name]')).toHaveText(['B', 'A']);
  await page.getByRole('searchbox', { name: 'Filter the Trash' }).fill('a');
  await expect(today.locator('[data-name]')).toHaveText(['A']);
  await page.getByRole('searchbox', { name: 'Filter the Trash' }).fill('');
  await page.getByRole('combobox', { name: 'Sort' }).selectOption('name');
  await expect(page.getByRole('list', { name: 'All items' }).locator('[data-name]')).toHaveText([
    'A',
    'B',
  ]);

  await page.getByRole('checkbox', { name: 'Select A' }).check();
  await page.getByRole('checkbox', { name: 'Select B' }).check();
  const bar = page.getByRole('region', { name: 'Selection' });
  await expect(bar).toContainText('2 selected');
  await bar.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('heading', { name: 'The Trash is empty' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'A', exact: true })).toBeVisible();

  for (const name of ['A', 'B']) {
    await page.getByRole('treeitem', { name, exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page
      .getByRole('dialog', { name: `Move “${name}” to Trash?` })
      .getByRole('button', { name: 'Move to Trash' })
      .click();
  }
  await page.getByRole('checkbox', { name: 'Select A' }).check();
  await page.getByRole('checkbox', { name: 'Select B' }).check();
  await page
    .getByRole('region', { name: 'Selection' })
    .getByRole('button', { name: 'Delete' })
    .click();
  const confirm = page.getByRole('dialog', { name: 'Delete 2 items from the vault?' });
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('heading', { name: 'The Trash is empty' })).toBeVisible();
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
