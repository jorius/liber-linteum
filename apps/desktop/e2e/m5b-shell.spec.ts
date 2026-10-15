// M5b Stream A in the built UI, in Chromium and WebKit (≈ WKWebView): no top
// bar — the floating Edit / Global view / Search button, the vault menu, the
// collapsible sidebar, the title in the page — and Auto save off (⌘S, and
// Save / Don't Save / Cancel before unsaved text is left).
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const LONG = Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of the long page.`).join('\n\n');

async function open(page: Page, name: string, settings: Record<string, unknown> = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages: { 'A.md': '# A\n\nText.\n', 'B.md': '# B\n\nMore.\n', 'Long.md': `# Long\n\n${LONG}\n` },
    editorMode: 'livePreview',
    remoteCover: false,
    settings,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue(name);
  return errors;
}

const writes = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __nimwWrites?: { path: string; text: string }[] }).__nimwWrites ?? [],
  );

test('the floating button opens the Global View and Search; no top bar', async ({ page }) => {
  const errors = await open(page, 'A');
  await expect(page.getByRole('banner')).toHaveCount(0);
  const actions = page.getByRole('button', { name: 'Actions', exact: true });
  await actions.click();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.evaluate(AXE);
  const violations = await page.evaluate(async () => {
    const { axe } = window as unknown as {
      axe: {
        run: (
          el: { include: string[][] },
          o: object,
        ) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
      };
    };
    const res = await axe.run({ include: [['[data-place]']] }, { resultTypes: ['violations'] });
    return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`);
  });
  expect(violations).toEqual([]);
  await page.getByRole('button', { name: 'Global view', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Global View' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+j');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Search' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the floating button never covers the last line of text', async ({ page }) => {
  await open(page, 'Long');
  await page.locator('.cm-scroller').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  const last = page.locator('.cm-line').filter({ hasText: 'Line 80 of the long page.' });
  await expect(last).toBeVisible();
  const line = (await last.boundingBox())!;
  const fab = (await page.getByRole('button', { name: 'Actions', exact: true }).boundingBox())!;
  expect(line.y + line.height).toBeLessThanOrEqual(fab.y);
});

test('the sidebar collapses and comes back (button and ⌘\\)', async ({ page }) => {
  const errors = await open(page, 'A');
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await expect(page.getByRole('complementary')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect(page.getByRole('complementary')).toBeVisible();
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await expect(page.getByRole('complementary')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the vault menu opens Settings', async ({ page }) => {
  await open(page, 'A');
  await page.locator('[data-vault-menu]').click();
  await page.getByRole('menuitem', { name: 'Settings…' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
});

test('auto save off: nothing is written until ⌘S; leaving asks first', async ({ page }) => {
  const errors = await open(page, 'A', { autoSave: false });
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' More words.');
  const status = page.getByRole('status', { name: 'Save status' });
  await expect(status).toHaveText('Unsaved');
  await expect(status).toHaveAttribute('data-status', 'unsaved');
  await page.waitForTimeout(1200);
  expect(await writes(page)).toEqual([]);

  // Opening another page asks; Cancel stays on this one.
  await page.getByRole('treeitem', { name: 'B', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Save changes to “A”?' });
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('A');
  expect(await writes(page)).toEqual([]);

  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(status).toHaveText('Saved');
  await expect.poll(async () => (await writes(page)).at(-1)?.text).toContain('More words.');
  expect(errors).toEqual([]);
});
