// M5b §7.3: ⌘⇧F opens Search from every view (⌘F too, outside the editor:
// there it finds in the page), in Chromium and WebKit (≈ WKWebView); from
// the editor, a short selection becomes its text.
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages: { 'Smaug.md': '# Smaug\n\nA red wyrm sleeps under the mountain.\n' },
    editorMode: 'livePreview',
    remoteCover: false,
    settings: {},
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  return errors;
}

const field = (page: Page) => page.getByRole('combobox', { name: 'Search the vault' });

test('⌘⇧F in the editor opens Search with the selected word', async ({ page }) => {
  const errors = await open(page);
  await page.getByRole('treeitem', { name: 'Smaug', exact: true }).click();
  await page.locator('.cm-line', { hasText: 'A red wyrm' }).dblclick({ position: { x: 50, y: 8 } });
  const word = await page.evaluate(() => document.getSelection()?.toString().trim());
  expect(word).toBeTruthy();
  await page.keyboard.press('ControlOrMeta+Shift+F');
  await expect(field(page)).toBeFocused();
  await expect(field(page)).toHaveValue(word!);
  expect(errors).toEqual([]);
});

test('⌘F opens Search from the Global View', async ({ page }) => {
  await open(page);
  await page.keyboard.press('ControlOrMeta+2');
  await page.keyboard.press('ControlOrMeta+F');
  await expect(field(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(field(page)).toBeHidden();
});
