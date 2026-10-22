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

test('a click outside closes Settings and saves a theme colour typed but not confirmed', async ({
  page,
}) => {
  const errors = await open(page);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await openSettings(page, 'Appearance');
  // A press inside released outside is a selection or a drag, not a close.
  const box = (await dialog.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.mouse.down();
  // The bottom-left corner: the backdrop (the top-left one is the title bar
  // outside macOS).
  const corner = { x: 4, y: page.viewportSize()!.height - 4 };
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.up();
  await expect(dialog).toBeVisible();

  // Custom themes §3: the accent lives in a theme of your own now.
  await dialog.getByRole('button', { name: 'New theme' }).click();
  const hex = dialog.getByRole('textbox', { name: 'Primary colour (hex)', exact: true });
  await hex.fill('#123456');
  await page.mouse.click(corner.x, corner.y);
  await expect(dialog).toBeHidden();

  await openSettings(page, 'Appearance');
  await expect(
    dialog.getByRole('textbox', { name: 'Primary colour (hex)', exact: true }),
  ).toHaveValue('#123456');
  expect(errors).toEqual([]);
});
