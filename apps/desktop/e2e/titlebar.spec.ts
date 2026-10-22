// Custom title bar (Linux, Windows) in the built UI: the menus of the macOS
// app menu in a bar the page draws, over every screen. On a macOS host the
// page keeps the system frame, so these checks skip there.
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

async function start(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages: { 'A.md': '# A\n\nText.\n', 'B.md': '# B\n\nMore.\n' },
    editorMode: 'livePreview',
    remoteCover: false,
  });
  await page.goto('/');
  const mac = await page.evaluate(() => /Mac/i.test(navigator.platform));
  test.skip(mac, 'macOS keeps the system title bar and its app menu');
  return errors;
}

const menuIds = (page: Page) =>
  page.evaluate(() => (window as unknown as { __liberMenu?: string[] }).__liberMenu ?? []);

test('the bar sits above Welcome and the shell, and nothing hides under it', async ({ page }) => {
  const errors = await start(page);
  const bar = page.locator('section[data-titlebar]');
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('menubar', { name: 'Menus' })).toBeVisible();
  const height = (await bar.boundingBox())!.height;
  // Welcome starts below the bar.
  const welcome = (await page.locator('#root > :not([data-titlebar])').first().boundingBox())!;
  expect(welcome.y).toBeGreaterThanOrEqual(height - 1);
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name: 'A', exact: true }).click();
  await expect(bar).toContainText('A — vault');
  const side = (await page.locator('aside').first().boundingBox())!;
  expect(side.y).toBeGreaterThanOrEqual(height - 1);
  expect(errors).toEqual([]);
});

test('menus run their items: Settings, View toggles, Global View', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name: 'A', exact: true }).click();
  const bar = page.getByRole('menubar', { name: 'Menus' });

  await bar.getByRole('menuitem', { name: 'Liber Linteum' }).click();
  await page.getByRole('menuitem', { name: /Settings…/ }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.keyboard.press('Escape');

  await bar.getByRole('menuitem', { name: 'View' }).click();
  const toolbar = page.getByRole('menuitemcheckbox', { name: /Formatting toolbar/ });
  const was = await toolbar.getAttribute('aria-checked');
  await toolbar.click();
  await bar.getByRole('menuitem', { name: 'View' }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: /Formatting toolbar/ })).toHaveAttribute(
    'aria-checked',
    was === 'true' ? 'false' : 'true',
  );
  await page.getByRole('menuitem', { name: /Global View/ }).click();
  await expect(page.locator('.react-flow')).toBeVisible();
  expect(await menuIds(page)).toEqual([
    'liber-settings',
    'liber-toggle-toolbar',
    'liber-screen-global',
  ]);
});

test('Edit → Undo acts on the editor that had the keyboard', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name: 'A', exact: true }).click();
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' More');
  await expect(editor).toContainText('Text. More');
  const bar = page.getByRole('menubar', { name: 'Menus' });
  await bar.getByRole('menuitem', { name: 'Edit' }).click();
  await page.getByRole('menuitem', { name: /^Undo/ }).click();
  await expect(editor).not.toContainText('More');
  await expect(editor).toBeFocused();
});

test('the keyboard: F10 into the menus, arrows across, Escape back', async ({ page }) => {
  await start(page);
  await page.keyboard.press('F10');
  await expect(page.getByRole('menuitem', { name: 'About Liber Linteum' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menu', { name: 'File' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
});
