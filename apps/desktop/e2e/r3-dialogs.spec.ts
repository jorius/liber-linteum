// Round 3 §3: dialogs and fields in the built UI, in Chromium and WebKit
// (≈ WKWebView, whose native select was the odd one out).
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';
import { openSettings } from './shell';

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages: { 'A.md': '# A\n\nText.\n', 'Cyber/Linux/B.md': '# B\n', 'Notes/C.md': '# C\n' },
    folders: ['Cyber', 'Cyber/Linux', 'Notes'],
    editorMode: 'livePreview',
    settings: {},
    remoteCover: false,
  });
  await page.goto('/');
  return errors;
}

const height = async (l: Locator) => Math.round((await l.boundingBox())!.height);

test('the Notion import dialog keeps its padding; its fields are the app size', async ({
  page,
}) => {
  const errors = await open(page);
  await page.getByRole('button', { name: 'Import a Notion export' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import from Notion' });
  const box = (await dialog.boundingBox())!;
  const title = (await dialog.getByRole('heading', { name: 'Import from Notion' }).boundingBox())!;
  expect(title.x - box.x).toBeGreaterThanOrEqual(20);
  expect(await dialog.evaluate((d) => getComputedStyle(d).paddingLeft)).toBe('24px');
  expect(await height(dialog.getByRole('textbox', { name: 'Vault name' }))).toBe(36);
  expect(await height(dialog.getByText('No file chosen'))).toBe(36);
  expect(await height(dialog.getByRole('button', { name: 'Choose export…' }))).toBe(36);
  expect(errors).toEqual([]);
});

test('Settings: selects and text fields are one size', async ({ page }) => {
  const errors = await open(page);
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name: 'A', exact: true }).click();
  await openSettings(page);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog
    .getByRole('navigation', { name: 'Settings categories' })
    .getByRole('button', { name: 'This vault' })
    .click();
  const where = dialog.getByRole('combobox', { name: 'New attachments go to' });
  await where.selectOption('subfolder');
  const sub = dialog.getByRole('textbox', { name: 'Subfolder name' });
  const quick = dialog.getByRole('textbox', { name: 'Quick notes folder' });
  expect(await height(where)).toBe(36);
  expect(await height(sub)).toBe(36);
  expect(await height(quick)).toBe(36);
  const radius = (l: Locator) => l.evaluate((e) => getComputedStyle(e).borderTopLeftRadius);
  expect(await radius(where)).toBe(await radius(sub));
  expect(errors).toEqual([]);
});

test('Move to…: a folder tree, filtered and driven by the keyboard', async ({ page }) => {
  const errors = await open(page);
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name: 'A', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Move “A”' });
  const tree = dialog.getByRole('tree', { name: 'Destination folder' });
  await expect(tree.getByRole('treeitem', { name: /Vault root.*current/ })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  const filter = dialog.getByRole('searchbox', { name: 'Filter folders' });
  await expect(filter).toBeFocused();
  await filter.fill('lin');
  await expect(tree.getByRole('treeitem')).toHaveText([/Vault root/, 'Cyber', 'Linux']);
  await filter.press('ArrowDown');
  await page.keyboard.press('End');
  await expect(tree.getByRole('treeitem', { name: 'Linux' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  // Moved, and shown where it went.
  await expect(page.getByRole('treeitem', { name: 'A', exact: true })).toHaveAttribute(
    'data-path',
    'Cyber/Linux/A.md',
  );
  expect(errors).toEqual([]);
});
