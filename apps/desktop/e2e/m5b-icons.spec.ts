// M5b §3, §4: the sidebar rows' quick actions and optional emoji icons, in
// the built UI, in Chromium and WebKit (≈ WKWebView).
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages: { 'Lore/A.md': '# A\n\nText.\n', 'Welcome.md': '# Welcome\n' },
    folders: ['Lore'],
    editorMode: 'livePreview',
    settings: {},
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await expect(page.getByRole('treeitem', { name: 'Lore' })).toBeVisible();
  return errors;
}

const row = (page: Page, name: string) => page.getByRole('treeitem', { name, exact: true });

test('a folder’s quick actions: + makes a page inside, ☺ sets its icon everywhere', async ({
  page,
}) => {
  const errors = await open(page);
  await row(page, 'Lore').hover();
  await page.getByRole('button', { name: 'New page in Lore' }).click();
  await expect(page.getByRole('textbox', { name: 'Rename' })).toBeVisible();
  await page.keyboard.press('Escape');

  await row(page, 'Lore').hover();
  await page.getByRole('button', { name: 'Icon for Lore' }).click();
  const picker = page.getByRole('dialog', { name: 'Icon for Lore' });
  await picker.getByRole('searchbox', { name: 'Search emoji' }).fill('rocket');
  await expect(picker.getByRole('gridcell').first()).toHaveAccessibleName('rocket');
  await page.keyboard.press('Enter');
  await expect(picker).toBeHidden();
  await expect(row(page, 'Lore')).toContainText('🚀Lore');

  await row(page, 'A').click();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('🚀Lore');
  expect(errors).toEqual([]);
});

test('the header’s icon button writes the page’s frontmatter; 🗑 asks first', async ({ page }) => {
  const errors = await open(page);
  await row(page, 'Lore').click();
  await row(page, 'A').click();
  await page.getByRole('button', { name: 'Add an icon to A' }).click();
  await page.getByRole('searchbox', { name: 'Search emoji' }).fill('dragon');
  await expect(page.getByRole('gridcell').first()).toHaveAccessibleName('dragon');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Change the icon of A' })).toContainText('🐉');
  await expect
    .poll(() =>
      page.evaluate(() =>
        ((window as unknown as { __nimwWrites?: { text: string }[] }).__nimwWrites ?? []).some(
          (w) => w.text.startsWith('---\nicon: 🐉\n---\n'),
        ),
      ),
    )
    .toBe(true);

  await row(page, 'Welcome').hover();
  await page.getByRole('button', { name: 'Move Welcome to Trash' }).click();
  const confirm = page.getByRole('dialog', { name: /Move “Welcome” to Trash/ });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(row(page, 'Welcome')).toBeVisible();
  expect(errors).toEqual([]);
});

for (const theme of ['light', 'dark'] as const) {
  test(`the picker is axe-clean (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await open(page);
    await row(page, 'Lore').hover();
    await page.getByRole('button', { name: 'Icon for Lore' }).click();
    await expect(page.getByRole('gridcell').first()).toBeVisible();
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
