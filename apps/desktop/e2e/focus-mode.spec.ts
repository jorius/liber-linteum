// Focus mode in the built UI, in Chromium and WebKit (≈ WKWebView): the
// chrome goes, the editor stays (the same one, in Live Preview), the strip
// shows ←, words and Saved; double Escape brings everything back.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

type W = Window & {
  __liberFullscreen?: boolean;
  __liberSettingsPatches?: Record<string, unknown>[];
  __liberEmit: (e: string, p: unknown) => void;
  __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
};

async function open(
  page: Page,
  name: string,
  settings: Record<string, unknown> = {},
  extra: Record<string, string> = {},
) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages: { 'A.md': '# A\n\nSee [[B]] here.\n', 'B.md': '# B\n\nMore.\n', ...extra },
    editorMode: 'split',
    remoteCover: false,
    settings: { editorMode: 'split', outline: true, toolbar: true, ...settings },
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue(name);
  return errors;
}

const enter = async (page: Page) => {
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('ControlOrMeta+Alt+KeyZ');
  await expect(page.locator('[data-focus-strip]')).toBeVisible();
};
const leave = async (page: Page) => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus-strip]')).toHaveCount(0);
};
const title = (page: Page) => page.getByRole('textbox', { name: 'Page title' });
const outline = (page: Page) => page.getByRole('complementary', { name: 'Outline' });

test('hides everything but the text', async ({ page }) => {
  const errors = await open(page, 'A');
  await expect(page.locator('[role="toolbar"]').first()).toBeVisible();
  await expect(outline(page)).toBeVisible();
  await enter(page);
  await expect(page.locator('[data-path="A.md"]')).toHaveCount(0);
  await expect(title(page)).toBeHidden();
  await expect(page.locator('[role="toolbar"]')).toHaveCount(0);
  await expect(outline(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Actions', exact: true })).toHaveCount(0);
  await expect(page.locator('.cm-gutters')).toHaveCount(0);
  const strip = page.locator('[data-focus-strip]');
  await expect(strip).toContainText('words');
  await expect(strip).toContainText('Saved');
  await expect(page.getByRole('region', { name: 'Preview' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('keeps the same editor', async ({ page }) => {
  await open(page, 'A');
  const before = await page.locator('.cm-editor').elementHandle();
  const content = page.locator('.cm-content').first();
  const text = (await content.textContent()) ?? '';
  await enter(page);
  await page.keyboard.press('End');
  await page.keyboard.type('x');
  await expect(content).not.toHaveText(text);
  await leave(page);
  expect(
    await page.evaluate((el) => el!.isSameNode(document.querySelector('.cm-editor')), before),
  ).toBe(true);
  await expect(content).not.toHaveText(text);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(content).toHaveText(text);
});

test('restores split mode and the chrome', async ({ page }) => {
  await open(page, 'A');
  await enter(page);
  await leave(page);
  await expect(page.locator('[data-path="A.md"]')).toBeVisible();
  await expect(title(page)).toBeVisible();
  await expect(outline(page)).toBeVisible();
  await expect(page.locator('[role="toolbar"]').first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Preview' })).toBeVisible();
  const patches = await page.evaluate(() => (window as unknown as W).__liberSettingsPatches ?? []);
  expect(patches.filter((p) => 'editorMode' in p)).toEqual([]);
});

test('stays focused across a link and goes back', async ({ page }) => {
  await open(page, 'A');
  await enter(page);
  await page.locator('.cm-liber-link', { hasText: 'B' }).click();
  await expect(page.locator('.cm-content').first()).toContainText('More.');
  await expect(title(page)).toBeHidden();
  const strip = page.locator('[data-focus-strip]');
  await expect(strip).toBeVisible();
  await strip.getByRole('button', { name: 'Back to A' }).click();
  await expect(page.locator('.cm-content').first()).toContainText('See');
  await expect(strip).toBeVisible();
});

test('keeps the orphan / unwritable notice', async ({ page }) => {
  await open(page, 'A', { autoSave: false });
  await enter(page);
  await page.keyboard.type('unsaved');
  // Deleted outside while it has unsaved text: the page is kept, with its banner.
  await page.evaluate(async () => {
    const w = window as unknown as W;
    await w.__TAURI_INTERNALS__.invoke('entry_trash', { path: 'A.md' });
    w.__liberEmit('vault:changed', { created: [], modified: [], removed: ['A.md'], renamed: [] });
  });
  await expect(page.getByText('This page was deleted outside the app.')).toBeVisible();
  await expect(page.locator('[data-focus-strip]')).toBeVisible();
});

test('full screen', async ({ page }) => {
  await open(page, 'A');
  const full = () => page.evaluate(() => (window as unknown as W).__liberFullscreen ?? false);
  await enter(page);
  await expect.poll(full).toBe(true);
  await leave(page);
  await expect.poll(full).toBe(false);
  await page.evaluate(() => ((window as unknown as W).__liberFullscreen = true));
  await enter(page);
  await leave(page);
  expect(await full()).toBe(true);
});

test('double Escape right after typing leaves', async ({ page }) => {
  await open(page, 'A');
  await enter(page);
  await page.keyboard.type('abc');
  await leave(page);
});

test('no title bar space while focused', async ({ page }) => {
  await open(page, 'A');
  // The custom title bar's layout (Windows/Linux), forced on any platform.
  await page.evaluate(() => document.documentElement.setAttribute('data-titlebar', ''));
  const top = () =>
    page.evaluate(() => getComputedStyle(document.getElementById('root')!).paddingTop);
  expect(await top()).toBe('38px');
  await enter(page);
  expect(await top()).toBe('0px');
  await leave(page);
  expect(await top()).toBe('38px');
});

// One Escape that closes an overlay is never half of a double Escape.
const strip = (page: Page) => page.locator('[data-focus-strip]');
const FIXTURES = {
  'Spell.md': '# Spell\n\nI recieve mail.\n',
  'Code.md': '# Code\n\n```js\nconst a = 1;\n```\n',
};
const overlays: [string, string, (page: Page) => Promise<unknown>, (page: Page) => Locator][] = [
  [
    '[[ link list',
    'A',
    async (page) => page.keyboard.type('[['),
    (page) => page.locator('.cm-tooltip-autocomplete'),
  ],
  [
    'find in page',
    'A',
    async (page) => page.keyboard.press('ControlOrMeta+F'),
    (page) => page.locator('.cm-search'),
  ],
  [
    'go to line',
    'A',
    async (page) => page.keyboard.press('Control+G'),
    (page) => page.locator('.cm-liber-goto'),
  ],
  [
    'Search dialog',
    'A',
    async (page) => page.keyboard.press('ControlOrMeta+Shift+F'),
    (page) => page.getByRole('dialog', { name: 'Search' }),
  ],
  [
    'language picker',
    'Code',
    async (page) => page.getByRole('button', { name: 'Language: JavaScript' }).click(),
    (page) => page.getByRole('combobox', { name: 'Code language' }),
  ],
  [
    'spell menu',
    'Spell',
    async (page) => page.locator('.cm-liber-misspelled').click({ button: 'right' }),
    (page) => page.getByRole('menu', { name: 'Spelling: recieve' }),
  ],
];
// The table tool lives in the toolbar, which Focus mode hides: nothing to open.
for (const [name, pageName, openIt, overlay] of overlays) {
  test(`one Escape in the ${name} stays focused`, async ({ page }) => {
    await open(page, pageName, {}, FIXTURES);
    await enter(page);
    await openIt(page);
    await expect(overlay(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(overlay(page)).toHaveCount(0);
    await expect(strip(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    await expect(strip(page)).toBeVisible();
    await leave(page);
  });
}

test('plain Escape, an overlay-closing Escape, then a plain Escape stays focused', async ({
  page,
}) => {
  await open(page, 'A');
  await enter(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+G');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  await expect(strip(page)).toBeVisible();
});
