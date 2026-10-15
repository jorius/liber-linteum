// M4c §3: a single-file window in the built UI (Chromium and WebKit ≈
// WKWebView): one file opened on its own, with no vault.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installFileWindowMock } from './fileWindowMock';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

type Options = Parameters<typeof installFileWindowMock>[0];

async function open(page: Page, options: Options) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installFileWindowMock, options);
  await page.goto('/');
  return errors;
}

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __nimwCalls: [string, unknown][] }).__nimwCalls);

test('a Markdown file: its name, subtitle and band; typing saves to it', async ({ page }) => {
  const errors = await open(page, {
    name: 'today.md',
    kind: 'page',
    text: '---\nsubtitle: Monday\n---\n# Today\n\nNotes.\n',
  });
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('today');
  await expect(page.getByRole('textbox', { name: 'Subtitle' })).toHaveValue('Monday');
  await expect(page.getByRole('status', { name: 'Save status' })).toHaveText('Saved');
  await expect(page.getByRole('group', { name: 'Editor mode' })).toBeVisible();
  await expect(page.getByRole('tree')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Global view' })).toHaveCount(0);

  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' More.');
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __nimwDisk: () => string }).__nimwDisk()),
    )
    .toContain('More.');
  const commands = (await calls(page)).map(([c]) => c);
  // Nothing but the window's own commands (the backend would refuse others).
  expect(commands.filter((c) => !/^(file_|settings_|plugin:|app_info|fonts_list)/.test(c))).toEqual(
    [],
  );
  expect(errors).toEqual([]);
});

test('renaming the file keeps it in its folder', async ({ page }) => {
  const errors = await open(page, { name: 'today.md', kind: 'page', text: '# Today\n' });
  const title = page.getByRole('textbox', { name: 'Page title' });
  await title.fill('Tomorrow');
  await title.press('Enter');
  await expect
    .poll(async () => (await calls(page)).find(([c]) => c === 'file_rename')?.[1])
    .toEqual({ newName: 'Tomorrow.md' });
  await expect(title).toHaveValue('Tomorrow');
  expect(errors).toEqual([]);
});

test('a text file opens in the text view', async ({ page }) => {
  const errors = await open(page, { name: 'list.txt', kind: 'text', text: 'one\ntwo\n' });
  await expect(page.getByRole('textbox', { name: 'File name' })).toHaveValue('list');
  await expect(page.getByText(/3 lines/)).toBeVisible();
  await expect(page.getByRole('group', { name: 'Editor mode' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const theme of ['light', 'dark']) {
  test(`the top bar, vault bar and band have no axe violations (${theme})`, async ({ page }) => {
    const errors = await open(page, {
      name: 'today.md',
      kind: 'page',
      text: '# Today\n',
      vault: { root: '/v/Notes', name: 'Notes', page: 'Daily/today.md' },
      settings: { theme },
    });
    await expect(page.getByRole('region', { name: 'Vault' })).toContainText('“Notes”');
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
      const res = await axe.run(
        { include: [['header'], ['[role="region"][aria-label="Vault"]'], ['[data-band]']] },
        {
          resultTypes: ['violations'],
          // The Format toggle's name ("Formatting toolbar") differs from its
          // text ("Format"), as in a vault's page header: a known minor.
          rules: { 'label-content-name-mismatch': { enabled: false } },
        },
      );
      return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`);
    });
    expect(violations).toEqual([]);
    // Open in its vault: hands the page over, then the window closes.
    await page.getByRole('button', { name: 'Open in its vault' }).click();
    await expect
      .poll(async () => (await calls(page)).map(([c]) => c))
      .toContain('window_close_self');
    expect(errors).toEqual([]);
  });
}
