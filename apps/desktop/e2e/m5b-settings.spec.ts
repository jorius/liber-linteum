// M5b §18: Settings in categories — a left menu like the file explorer, one
// category at a time, a search across all of them — in the built UI, in
// Chromium and WebKit (≈ WKWebView).
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';
import { openSettings } from './shell';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

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

test('categories, search, a change, and Escape saves and closes', async ({ page }) => {
  const errors = await open(page);
  await openSettings(page);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const nav = dialog.getByRole('navigation', { name: 'Settings categories' });
  await expect(nav.getByRole('button', { name: 'This vault' })).toBeVisible();

  await nav.getByRole('button', { name: 'Editor', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Editor', level: 3 })).toBeFocused();
  await expect(dialog.getByRole('combobox', { name: 'Language' })).toBeHidden();

  // The dialog keeps its size; only the pane scrolls.
  const before = (await dialog.boundingBox())!;
  await nav.getByRole('button', { name: 'General', exact: true }).click();
  const after = (await dialog.boundingBox())!;
  expect(after.height).toBe(before.height);

  const search = dialog.getByRole('searchbox', { name: 'Search settings' });
  await search.fill('line');
  await expect(dialog.getByRole('heading', { name: 'Search results', level: 3 })).toBeVisible();
  await dialog.getByRole('checkbox', { name: 'Show line numbers' }).check();
  await search.fill('');
  await expect(dialog.getByRole('combobox', { name: 'Language' })).toBeVisible();

  // Contrast included, in light and dark (the menu keeps the sidebar's colours).
  await page.evaluate(AXE);
  const audit = () =>
    page.evaluate(async () => {
      const { axe } = window as unknown as {
        axe: { run: (el: Element) => Promise<{ violations: { id: string }[] }> };
      };
      const r = await axe.run(document.querySelector('[role="dialog"]')!);
      return r.violations.map((v) => v.id);
    });
  expect(await audit()).toEqual([]);
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await audit()).toEqual([]);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('.cm-lineNumbers')).toBeVisible();
  expect(errors).toEqual([]);
});
