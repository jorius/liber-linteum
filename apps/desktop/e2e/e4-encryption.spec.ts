// E4: the encrypted-vault UI. Tasks 3-6 append to this file.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const PASSPHRASE = 'correct horse battery';
const encrypted: { passphrase: string; recovery: string; damaged?: boolean } = {
  passphrase: PASSPHRASE,
  recovery: 'LIBER-AAAA-BBBB',
};

const setup = (page: import('@playwright/test').Page, extra: object = {}, enc = encrypted) =>
  page.addInitScript(installIpcMock, {
    pages: { 'Welcome.md': '# Welcome\n\nStart here.\n' },
    editorMode: 'livePreview',
    remoteCover: false,
    encrypted: enc,
    ...extra,
  });

test('an encrypted vault shows a lock in the recent list and opens at Unlock', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  const row = page.getByRole('button', { name: /^enc Encrypted/ });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId('unlock-screen')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'enc' })).toBeVisible();
  await expect(page.getByLabel('Passphrase')).toBeFocused();
});

test('a wrong passphrase, then the right one, opens the shell', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await page.getByRole('button', { name: /^enc Encrypted/ }).click();
  await page.getByLabel('Passphrase').fill('not the passphrase');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText("That passphrase doesn't open this vault.");
  await page.getByLabel('Passphrase').fill(PASSPHRASE);
  await page.getByLabel('Passphrase').press('Enter');
  await expect(page.getByTestId('unlock-screen')).toHaveCount(0);
  await expect(page.locator('[data-vault-menu]')).toBeVisible();
});

test('a damaged rollback memory can be reset, then the vault unlocks', async ({ page }) => {
  await setup(page, {}, { ...encrypted, damaged: true });
  await page.goto('/');
  await page.getByRole('button', { name: /^enc Encrypted/ }).click();
  await page.getByLabel('Passphrase').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: /Reset this computer/ }).click();
  await page.getByRole('button', { name: 'Reset rollback memory', exact: true }).click();
  await expect(page.getByText('Rollback memory reset. Try unlocking again.')).toBeVisible();
  await page.getByLabel('Passphrase').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByTestId('unlock-screen')).toHaveCount(0);
});

for (const theme of ['light', 'dark']) {
  test(`the Unlock screen is axe-clean (${theme})`, async ({ page }) => {
    await setup(page, { settings: { theme } });
    await page.goto('/');
    await page.getByRole('button', { name: /^enc Encrypted/ }).click();
    await page.getByLabel('Passphrase').fill('nope');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.evaluate(AXE);
    const violations = await page.evaluate(async () => {
      const { axe } = window as unknown as {
        axe: {
          run: (
            el: Element,
            opts: object,
          ) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
        };
      };
      const res = await axe.run(document.body, { resultTypes: ['violations'] });
      return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`);
    });
    expect(violations).toEqual([]);
  });
}

const unlock = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^enc Encrypted/ }).click();
  await page.getByLabel('Passphrase').fill(PASSPHRASE);
  await page.getByLabel('Passphrase').press('Enter');
  await expect(page.locator('[data-vault-menu]')).toBeVisible();
};
const writes = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    ((window as unknown as { __liberWrites?: { text: string }[] }).__liberWrites ?? []).map(
      (w) => w.text,
    ),
  );

test('⌥⌘L locks the vault', async ({ page }) => {
  await setup(page);
  await unlock(page);
  await page.keyboard.press('Alt+Control+KeyL');
  await expect(page.getByTestId('unlock-screen')).toBeVisible();
});

test('a sleep request saves an unsaved edit (auto save off), then Unlock shows', async ({
  page,
}) => {
  await setup(page, { settings: { autoSave: false } });
  await unlock(page);
  await page.getByRole('treeitem', { name: 'Welcome', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('typed before sleep');
  expect(await writes(page)).toEqual([]);
  await page.evaluate(() =>
    (window as unknown as { __liberEmit: (e: string, p: unknown) => void }).__liberEmit(
      'vault:lock-request',
      { reason: 'sleep' },
    ),
  );
  await expect(page.getByTestId('unlock-screen')).toBeVisible();
  expect((await writes(page)).join('\n')).toContain('typed before sleep');
});
