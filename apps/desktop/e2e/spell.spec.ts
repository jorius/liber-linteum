// Spell checking in the built UI, in Chromium and WebKit (≈ WKWebView): the
// underline, the menu (a suggestion, Add to dictionary), the off switch, and
// axe. The mock's dictionary knows one misspelling: "recieve".
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { installIpcMock } from './ipcMock';
import { openSettings } from './shell';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const PAGE = '# Spell\n\nI recieve mail.\n\n```\nrecieve\n```\n';

async function open(page: Page, settings: Record<string, unknown> = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages: { 'Spell.md': PAGE },
    editorMode: 'livePreview',
    settings,
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name: 'Spell' }).click();
  await expect(page.locator('.cm-content')).toContainText('I recieve mail.');
  return errors;
}

const underlined = (page: Page) => page.locator('.cm-nimw-misspelled');

test('a misspelled word is underlined; code is not', async ({ page }) => {
  const errors = await open(page);
  await expect(underlined(page)).toHaveCount(1);
  await expect(underlined(page)).toHaveText('recieve');
  expect(errors).toEqual([]);
});

test('right-click → a suggestion replaces it', async ({ page }) => {
  await open(page);
  await underlined(page).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Spelling: recieve' });
  await menu.getByRole('menuitem', { name: 'receive' }).click();
  await expect(page.locator('.cm-content')).toContainText('I receive mail.');
  await expect(underlined(page)).toHaveCount(0);
});

test('Add to dictionary removes the underline and survives a reload', async ({ page }) => {
  await open(page);
  await underlined(page).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add to dictionary' }).click();
  await expect(underlined(page)).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name: 'Spell' }).click();
  await expect(page.locator('.cm-content')).toContainText('I recieve mail.');
  await page.waitForTimeout(600);
  await expect(underlined(page)).toHaveCount(0);
});

test('spelling off: nothing underlined', async ({ page }) => {
  await open(page, { spellcheck: false });
  await page.waitForTimeout(600);
  await expect(underlined(page)).toHaveCount(0);
});

for (const theme of ['light', 'dark'] as const) {
  test(`the spelling menu and settings are axe-clean (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await open(page);
    await page.evaluate(AXE);
    const check = (selector: string) =>
      page.evaluate(async (sel) => {
        const { axe } = window as unknown as {
          axe: {
            run: (
              el: Element,
              o: object,
            ) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
          };
        };
        const res = await axe.run(document.querySelector(sel)!, { resultTypes: ['violations'] });
        return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`);
      }, selector);
    await underlined(page).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'receive' })).toBeVisible();
    expect(await check('[role="menu"]')).toEqual([]);
    await page.keyboard.press('Escape');
    await openSettings(page, 'Spelling');
    await expect(page.getByRole('checkbox', { name: 'Check spelling' })).toBeVisible();
    expect(await check('[role="dialog"]')).toEqual([]);
  });
}
