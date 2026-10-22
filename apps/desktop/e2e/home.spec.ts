// A vault's home, in the built UI with the mocked backend: set a page as home
// from its row menu, close and reopen the vault and it opens there; make the
// Global View the home from its toolbar and it opens there; choose it in
// Settings → This vault. `LIBER_SHOTS_DIR` saves screenshots of each.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';
import { openSettings, showGlobalView } from './shell';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

async function shot(page: Page, name: string) {
  const dir = process.env.LIBER_SHOTS_DIR;
  if (dir) await page.screenshot({ path: join(dir, `${test.info().project.name}-${name}.png`) });
}

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages: {
      'Lore/Dragons.md': '# Dragons\n\nFire and wings.\n',
      'Lore/Maps.md': '# Maps\n',
      'Welcome.md': '# Welcome\n',
    },
    folders: ['Lore'],
    editorMode: 'livePreview',
    settings: {},
    remoteCover: false,
  });
  await page.goto('/');
  await openVault(page);
  return errors;
}

async function openVault(page: Page) {
  await page.getByRole('button', { name: /^vault/ }).click();
  await expect(page.getByRole('treeitem', { name: 'Welcome', exact: true })).toBeVisible();
}

async function closeVault(page: Page) {
  await page.locator('[data-vault-menu]').click();
  await page.getByRole('menuitem', { name: 'Close vault' }).click();
  await expect(page.getByRole('button', { name: /^vault/ })).toBeVisible();
}

const row = (page: Page, name: string) => page.getByRole('treeitem', { name, exact: true });
const title = (page: Page) => page.getByRole('textbox', { name: 'Page title' });

async function axeClean(page: Page) {
  await page.evaluate(AXE);
  const violations = await page.evaluate(async () => {
    const r = await (
      window as unknown as {
        axe: { run: (n: Element, o: unknown) => Promise<{ violations: { id: string }[] }> };
      }
    ).axe.run(document.body, {
      rules: {
        'color-contrast': { enabled: false },
        // Pre-existing (M2b feedback round): the "Format" button is named
        // "Formatting toolbar"; not part of this change.
        'label-content-name-mismatch': { enabled: false },
      },
    });
    return r.violations.map(
      (v) =>
        `${v.id}: ${JSON.stringify((v as unknown as { nodes: { target: unknown }[] }).nodes.map((n) => n.target))}`,
    );
  });
  expect(violations).toEqual([]);
}

test('a page set as home from the tree: the vault opens there again', async ({ page }) => {
  const errors = await open(page);
  // Nothing chosen yet: the editor asks for a page, as before.
  await expect(title(page)).toHaveCount(0);
  await row(page, 'Lore').click();
  await row(page, 'Dragons').click({ button: 'right' });
  const item = page.getByRole('menuitem', { name: 'Set as home page' });
  await expect(item).toBeVisible();
  await shot(page, 'context-menu');
  await item.click();
  // The quiet house after its name, named "Home page".
  const glyph = row(page, 'Dragons').getByRole('img', { name: 'Home page' });
  await expect(glyph).toBeVisible();
  await expect(row(page, 'Dragons')).toHaveAttribute('aria-describedby', /.+/);
  await shot(page, 'tree-glyph');
  // Somewhere else, then close and reopen: home again, first on the trail.
  await row(page, 'Welcome').click();
  await expect(title(page)).toHaveValue('Welcome');
  await closeVault(page);
  await openVault(page);
  await expect(title(page)).toHaveValue('Dragons');
  await shot(page, 'reopened-at-home');
  await expect(row(page, 'Dragons')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Remove as home page' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as Record<string, unknown>).__liberWindowTitle),
    )
    .toBe('Dragons — vault');
  await axeClean(page);
  // The row menu now offers to remove it.
  await row(page, 'Dragons').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove as home page' }).click();
  await expect(page.getByRole('img', { name: 'Home page' })).toHaveCount(0);
  await closeVault(page);
  await openVault(page);
  await expect(title(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the Global View as home: the vault opens on it', async ({ page }) => {
  const errors = await open(page);
  await showGlobalView(page);
  const toggle = page.getByRole('button', { name: 'Use as home' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await shot(page, 'global-view-toggle');
  await closeVault(page);
  await openVault(page);
  await expect(page.getByRole('button', { name: 'Use as home' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('navigation', { name: 'Global View path' })).toBeVisible();
  await expect(title(page)).toHaveCount(0);
  await axeClean(page);
  expect(errors).toEqual([]);
});

test('Settings → This vault → Home: a page from the picker', async ({ page }) => {
  const errors = await open(page);
  await openSettings(page, 'This vault');
  const home = page.getByRole('combobox', { name: 'Home' });
  await expect(home).toHaveValue('none');
  await home.selectOption('page');
  const find = page.getByRole('combobox', { name: 'Find the home page' });
  await expect(find).toBeFocused();
  await find.fill('Map');
  await expect(page.getByRole('option', { name: /Maps/ })).toBeVisible();
  await shot(page, 'settings-picker');
  await page.getByRole('option', { name: /Maps/ }).click();
  await expect(page.locator('[data-home-page]')).toHaveText('Maps');
  await expect(page.getByRole('button', { name: 'Change…' })).toBeVisible();
  await shot(page, 'settings-home');
  await axeClean(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  await row(page, 'Lore').click();
  await expect(row(page, 'Maps').getByRole('img', { name: 'Home page' })).toBeVisible();
  await closeVault(page);
  await openVault(page);
  await expect(title(page)).toHaveValue('Maps');
  expect(errors).toEqual([]);
});
