// Round 3b: a folder with its own page is one row (§6), double-click opens a
// page for editing or renames it (§8.1), and search shows a page's icon in
// its icon box (§8.2) — in the built UI, in Chromium and WebKit.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';
import { openSearch, showGlobalView } from './shell';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages: {
      'Lore/Lore.md': '---\nicon: 🛡️\n---\n# Lore\n\nThe lore.\n',
      'Lore/Other.md': '# Other\n',
      'Welcome.md': '# Welcome\n',
    },
    folders: ['Lore'],
    editorMode: 'livePreview',
    settings: {},
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await expect(page.getByRole('treeitem', { name: 'Welcome' })).toBeVisible();
  return errors;
}

const title = (page: Page) => page.getByRole('textbox', { name: 'Page title' });

test('a folder with its own page is one row: the name opens it, the chevron expands', async ({
  page,
}) => {
  const errors = await open(page);
  const lore = page.getByRole('treeitem', { name: 'Lore' });
  await expect(lore).toHaveCount(1);
  await expect(lore).toContainText('🛡️');
  await lore.getByText('Lore', { exact: true }).click();
  await expect(title(page)).toHaveValue('Lore');
  await expect(lore).toHaveAttribute('aria-expanded', 'false');
  await expect(lore).toHaveAttribute('aria-current', 'page');
  await lore.locator('[data-twisty]').click();
  await expect(page.getByRole('treeitem', { name: 'Other' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'Lore' })).toHaveCount(1);
  // The sidebar stays axe-clean with the new row.
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
    const res = await axe.run(document.querySelector('[role="tree"]')!, {
      resultTypes: ['violations'],
    });
    return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`);
  });
  expect(violations).toEqual([]);
  expect(errors).toEqual([]);
});

test('double-click: from the Global View it opens the page; again on it, it renames', async ({
  page,
}) => {
  const errors = await open(page);
  await page.getByRole('treeitem', { name: 'Welcome' }).click();
  await expect(title(page)).toHaveValue('Welcome');
  await showGlobalView(page);
  await expect(title(page)).toHaveCount(0);
  await page.getByRole('treeitem', { name: 'Welcome' }).dblclick();
  await expect(title(page)).toHaveValue('Welcome');
  await expect(page.getByRole('textbox', { name: 'Rename' })).toHaveCount(0);
  await page.getByRole('treeitem', { name: 'Welcome' }).dblclick();
  await expect(page.getByRole('textbox', { name: 'Rename' })).toBeFocused();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test("search shows a page's icon in its icon box, not before its title", async ({ page }) => {
  const errors = await open(page);
  await openSearch(page);
  await page.getByRole('combobox', { name: 'Search the vault' }).fill('lore');
  const hit = page.getByRole('option', { name: /Lore/ }).first();
  await expect(hit).toBeVisible();
  await expect(hit.locator(':scope > span').first()).toHaveText('🛡️');
  await expect(hit.locator(':scope > span').nth(1).locator('span').first()).toHaveText('Lore');
  expect(errors).toEqual([]);
});
