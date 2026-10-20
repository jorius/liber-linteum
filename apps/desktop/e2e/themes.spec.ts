// Custom themes (spec §3, §4): the Appearance gallery and editor in the
// built UI, in Chromium and WebKit (≈ WKWebView).
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';
import { openSettings } from './shell';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

async function open(page: Page, theme = 'light') {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages: { 'A.md': '# A\n\nText #tag.\n' },
    editorMode: 'livePreview',
    settings: { theme },
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name: 'A', exact: true }).click();
  await openSettings(page, 'Appearance');
  return errors;
}

const rootVar = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test('create a theme, edit Primary, and the app follows; Light/Dark edits each mode', async ({
  page,
}) => {
  const errors = await open(page);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'New theme' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Theme name' })).toHaveValue('My theme');
  const hex = dialog.getByRole('textbox', { name: 'Primary colour (hex)', exact: true });
  await hex.fill('#0e7c7b');
  await expect.poll(() => rootVar(page, '--color-accent')).toBe('#0e7c7b');
  await dialog.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(hex).not.toHaveValue('#0e7c7b');
  // Review M15: edit the dark primary; each mode keeps its own.
  await hex.fill('#ffaa00');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await expect.poll(() => rootVar(page, '--color-accent')).toBe('#ffaa00');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await expect.poll(() => rootVar(page, '--color-accent')).toBe('#0e7c7b');
  expect(errors).toEqual([]);
});

test('a Low badge offers Fix, which brings it to AA; a built-in duplicates; delete confirms', async ({
  page,
}) => {
  const errors = await open(page);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Duplicate to edit' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Theme name' })).toHaveValue('Lavender copy');
  await dialog.getByRole('textbox', { name: 'Secondary text colour (hex)' }).fill('#cccccc');
  const row = dialog.getByRole('group', { name: 'Secondary text' });
  await expect(row.getByText(/^Low/)).toBeVisible();
  await row.getByRole('button', { name: 'Fix Secondary text' }).click();
  await expect(row.getByText(/^AA/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete “Lavender copy”' }).click();
  await expect(
    dialog.getByRole('radiogroup', { name: 'My themes' }).getByRole('radio'),
  ).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.palette))
    .toBe('lavender');
  expect(errors).toEqual([]);
});

test('export, then import the same file: a second theme, numbered and selected', async ({
  page,
}) => {
  const errors = await open(page);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'New theme' }).click();
  await dialog.getByRole('button', { name: 'Export…' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __liberThemeExports?: unknown[] }).__liberThemeExports?.length ??
          0,
      ),
    )
    .toBe(1);
  await page.evaluate(() => {
    const w = window as unknown as {
      __liberThemeExports: { json: string }[];
      __liberThemeImport?: string;
    };
    w.__liberThemeImport = w.__liberThemeExports[0].json;
  });
  await dialog.getByRole('button', { name: 'Import…' }).click();
  await expect(
    dialog.getByRole('radiogroup', { name: 'My themes' }).getByRole('radio'),
  ).toHaveCount(2);
  await expect(dialog.getByRole('textbox', { name: 'Theme name' })).toHaveValue('My theme 2');
  expect(errors).toEqual([]);
});

for (const theme of ['light', 'dark']) {
  test(`the Appearance panel is axe-clean (${theme})`, async ({ page }) => {
    await open(page, theme);
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('button', { name: 'New theme' }).click();
    await page.evaluate(AXE);
    const violations = await page.evaluate(async () => {
      const { axe } = window as unknown as {
        axe: {
          run: (
            el: Element,
            o: object,
          ) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
        };
      };
      const res = await axe.run(document.querySelector('[role="dialog"]')!, {
        resultTypes: ['violations'],
      });
      return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`);
    });
    expect(violations).toEqual([]);
  });
}
