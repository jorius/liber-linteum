// M5 §7: search in the built UI, in Chromium and WebKit (≈ WKWebView):
// ⌘⇧F, typing, opening a result, filter chips, typed filter words,
// snippets, axe in both themes, and nothing leaving the machine.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openSearch } from './shell';
import { installIpcMock } from './ipcMock';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

const PAGES = {
  'Lore/Smaug.md':
    '---\ntags: [lore, villain]\n---\n# Smaug\n\nA red wyrm sleeps under the mountain.\n',
  'Lore/Erebor.md': '# Erebor\n\nThe mountain of [[Smaug]]. ![[map.png]] #lore\n',
  'Game/Session 1.md': '# Session 1\n\nWe met [[Smaug]] near [[Erebor]].\n',
  'Welcome.md': '# Welcome\n\nStart here.\n',
};

async function open(
  page: Page,
  settings: Record<string, unknown> = {},
  extra: Record<string, string> = {},
) {
  const outside: string[] = [];
  const errors: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (!(url.protocol === 'http:' && url.hostname === '127.0.0.1') && url.protocol !== 'data:')
      outside.push(r.url());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, (route) => route.abort());
  await page.addInitScript(installIpcMock, {
    pages: { ...PAGES, ...extra },
    editorMode: 'livePreview',
    remoteCover: false,
    settings,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await expect(page.getByRole('button', { name: 'Actions', exact: true })).toBeVisible();
  return { outside, errors };
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Search' });
const field = (page: Page) => page.getByRole('combobox', { name: 'Search the vault' });

test('⌘⇧F, type, Enter opens the page in the editor', async ({ page }) => {
  const { errors } = await open(page);
  await page.keyboard.press('ControlOrMeta+Shift+F');
  await expect(field(page)).toBeFocused();
  await expect(dialog(page).getByRole('heading', { name: 'Recent' })).toBeVisible();
  await page.keyboard.type('wyrm');
  const option = dialog(page).getByRole('option', { name: /Smaug/ });
  await expect(option).toBeVisible();
  await expect(dialog(page).getByText('1 result', { exact: true })).toBeVisible();
  // A body match shows a highlighted snippet.
  await expect(option.locator('mark', { hasText: 'wyrm' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Smaug');
  expect(errors).toEqual([]);
});

test('a tag chip filters, and removing it restores Recent', async ({ page }) => {
  await open(page);
  await openSearch(page);
  const tags = dialog(page).getByRole('group', { name: 'Tags' });
  await tags.getByRole('button', { name: /#villain/ }).click();
  await expect(dialog(page).getByRole('option')).toHaveCount(1);
  await expect(tags.getByRole('button', { name: /#villain/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await dialog(page).getByRole('button', { name: 'Remove filter #villain' }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Recent' })).toBeVisible();
  await expect(dialog(page).getByRole('option')).toHaveCount(4);
});

test('typed filter words become chips; Escape clears, then closes', async ({ page }) => {
  await open(page);
  await page.keyboard.press('ControlOrMeta+Shift+F');
  await page.keyboard.type('mountain #lore ');
  await expect(field(page)).toHaveValue('mountain ');
  await expect(dialog(page).getByRole('button', { name: 'Remove filter #lore' })).toBeVisible();
  await expect(dialog(page).getByRole('option')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(field(page)).toHaveValue('');
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
});

test('nothing leaves the machine with search open', async ({ page }) => {
  const { outside, errors } = await open(page);
  await page.keyboard.press('ControlOrMeta+Shift+F');
  await page.keyboard.type('mountain');
  await expect(dialog(page).getByRole('option')).toHaveCount(2);
  await page.waitForLoadState('networkidle');
  expect(outside).toEqual([]);
  expect(
    await page.evaluate(
      () => (window as unknown as { __nimwCspViolations: string[] }).__nimwCspViolations,
    ),
  ).toEqual([]);
  expect(errors).toEqual([]);
});

for (const theme of ['light', 'dark']) {
  test(`the search dialog is axe-clean (${theme})`, async ({ page }) => {
    await open(page, { theme });
    await page.keyboard.press('ControlOrMeta+Shift+F');
    await page.keyboard.type('mountain');
    await dialog(page)
      .getByRole('group', { name: 'Tags' })
      .getByRole('button', { name: /#lore/ })
      .click();
    await expect(dialog(page).getByRole('option').first()).toBeVisible();
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

test('batch 6: words inside a .txt file are found, and Enter opens it in the text view', async ({
  page,
}) => {
  const { errors } = await open(page, {}, { 'Notes/todo.txt': 'buy dragonfruit and limes\n' });
  await openSearch(page);
  await page.keyboard.type('dragonfruit');
  const option = dialog(page).getByRole('option', { name: /todo\.txt/ });
  await expect(option).toBeVisible();
  await expect(option.getByText('TXT', { exact: true })).toBeVisible();
  await expect(option.locator('mark', { hasText: 'dragonfruit' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator('.cm-content')).toContainText('buy dragonfruit and limes');
  expect(errors).toEqual([]);
});
