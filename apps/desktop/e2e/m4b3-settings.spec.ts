// M4b part 3: Settings closes with Escape and with a click outside, and a
// value typed but not confirmed is saved first — in the built UI, in
// Chromium and WebKit (≈ WKWebView, which leaves a clicked checkbox
// unfocused, so focus sits on nothing when Escape is pressed).
import { expect, test, type Page } from '@playwright/test';
import { openSettings } from './shell';
import { installIpcMock } from './ipcMock';

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages: { 'A.md': '# A\n\nText.\n' },
    editorMode: 'livePreview',
    settings: {},
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name: 'A', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('A');
  return errors;
}

test('Escape closes Settings even when nothing in it has focus', async ({ page }) => {
  const errors = await open(page);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await openSettings(page, 'Editor');
  await dialog.getByRole('checkbox', { name: 'Show line numbers' }).check();
  // As after a click in WKWebView: focus on nothing.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('.cm-lineNumbers')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a click outside closes Settings and saves the accent typed but not confirmed', async ({
  page,
}) => {
  const errors = await open(page);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await openSettings(page, 'Appearance');
  // A press inside released outside is a selection or a drag, not a close.
  const box = (await dialog.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(4, 4);
  await page.mouse.up();
  await expect(dialog).toBeVisible();

  await dialog.getByRole('radio', { name: 'Custom accent' }).check();
  const hex = dialog.getByRole('textbox', { name: 'Accent colour (hex)' });
  await hex.fill('#123456');
  await page.mouse.click(4, 4);
  await expect(dialog).toBeHidden();

  await openSettings(page, 'Appearance');
  await expect(dialog.getByRole('textbox', { name: 'Accent colour (hex)' })).toHaveValue('#123456');
  expect(errors).toEqual([]);
});
