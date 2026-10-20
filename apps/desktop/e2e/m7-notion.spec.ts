// M7: the Notion import in the built UI, in Chromium and WebKit (≈ WKWebView).
// From the Welcome screen: pick the export (a preview with counts and
// warnings), pick the place, name the vault, import; the new vault opens at
// its report page. Dialogs and the import itself are answered by the mock.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

test('Import from Notion: preview, import, the new vault opens at its report', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages: {},
    editorMode: 'livePreview',
    settings: {},
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Import from Notion…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import from Notion' });
  const importButton = dialog.getByRole('button', { name: 'Import', exact: true });
  await expect(importButton).toHaveAttribute('aria-disabled', 'true');

  await dialog.getByRole('button', { name: 'Choose export…' }).click();
  await expect(dialog.getByText('Team wiki.zip')).toBeVisible();
  await expect(dialog.getByText('2 pages, 1 database with 1 row, 1 attachment.')).toBeVisible();
  await expect(dialog.getByText('1 warning')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Vault name' })).toHaveValue('Team wiki');
  await dialog.getByRole('button', { name: 'Choose location…' }).click();
  await expect(dialog.getByText('/Users/e2e/Notion')).toBeVisible();

  await page.evaluate(AXE);
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: { run: (n: Element) => Promise<{ violations: { id: string }[] }> };
      }
    ).axe;
    const r = await axe.run(document.querySelector('[role="dialog"]')!);
    return r.violations.map((v) => v.id);
  });
  expect(violations).toEqual([]);

  await expect(importButton).toHaveAttribute('aria-disabled', 'false');
  await importButton.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue(
    'Notion import report',
  );
  await expect(page.getByRole('treeitem', { name: 'Home', exact: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
});
