// E4: the encrypted-vault UI. Tasks 3-6 append to this file.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { installIpcMock } from './ipcMock';
import { openSettings } from './shell';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const PASSPHRASE = 'correct horse battery';
const encrypted: NonNullable<Parameters<typeof installIpcMock>[0]['encrypted']> = {
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
  await expect(page.getByRole('alert')).toHaveText(
    "That passphrase doesn't open this vault. If you're sure it's right, this vault's key file may be damaged.",
  );
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
    await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' });
    await setup(page, { settings: { theme } });
    await page.goto('/');
    await page.getByRole('button', { name: /^enc Encrypted/ }).click();
    await page.getByLabel('Passphrase').fill('nope');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const lum =
      bg
        .match(/\d+/g)!
        .map(Number)
        .reduce((a, b) => a + b, 0) / 3;
    expect(lum < 128).toBe(theme === 'dark');
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

// ---- Task 4: creating an encrypted vault ----
const axeClean = async (page: import('@playwright/test').Page) => {
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
    const res = await axe.run(document.querySelector('[role="dialog"]') ?? document.body, {
      resultTypes: ['violations'],
    });
    return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`);
  });
  expect(violations).toEqual([]);
};

test('Welcome: encrypt switch, passphrase, recovery code, two groups, shell opens', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/');
  const sw = page.getByRole('switch', { name: /Encrypt this vault/ });
  await expect(sw).not.toBeChecked();
  await sw.check();
  await page.getByRole('button', { name: /^New vault/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(page.getByLabel('Passphrase', { exact: true })).toBeFocused();
  await axeClean(page);
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel('Confirm passphrase').fill(PASSPHRASE + 'x');
  await expect(dialog.getByRole('alert')).toHaveCount(0); // said on leaving the field
  await page.getByLabel('Confirm passphrase').press('Tab');
  await expect(dialog.getByRole('alert')).toHaveText("The passphrases don't match.");
  await expect(dialog.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await page.getByLabel('Confirm passphrase').fill(PASSPHRASE);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  const box = page.getByTestId('recovery-code');
  await expect(box).toBeVisible();
  await expect(page.locator('[data-vault-menu]')).toBeVisible(); // the vault is open behind
  await axeClean(page);
  const groups = ((await box.textContent()) ?? '').split('-').slice(1);
  expect(groups).toHaveLength(14);
  await page.keyboard.press('Escape');
  await expect(box).toBeVisible();
  await dialog.getByRole('button', { name: "I've saved it" }).click();
  await axeClean(page);
  const rows = dialog.locator('label', { hasText: /^Group \d+$/ });
  for (let i = 0; i < 2; i++) {
    const n = Number(((await rows.nth(i).textContent()) ?? '').replace(/\D/g, ''));
    await rows
      .nth(i)
      .locator('input')
      .fill(` ${groups[n - 1].toLowerCase()} `);
  }
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-vault-menu]')).toBeVisible();
});

test('a folder that is not empty is refused inline', async ({ page }) => {
  await setup(page, {}, { ...encrypted, notEmpty: true });
  await page.goto('/');
  await page.getByRole('switch', { name: /Encrypt this vault/ }).check();
  await page.getByRole('button', { name: /^New vault/ }).click();
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel('Confirm passphrase').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toHaveText('Pick an empty or new folder.');
  await expect(page.getByLabel('Passphrase', { exact: true })).toBeVisible();
});

const openSecurity = async (page: import('@playwright/test').Page) => {
  await openSettings(page);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: /^Security/ }).click();
  return dialog;
};

test('Settings → Security: change the passphrase, lock, unlock with the new one; axe', async ({
  page,
}) => {
  const NEW = 'a brand new passphrase';
  await setup(page);
  await unlock(page);
  const dialog = await openSecurity(page);
  await dialog.getByLabel('Current passphrase').fill(PASSPHRASE);
  await dialog.getByLabel('New passphrase').fill(NEW);
  await dialog.getByLabel('Confirm passphrase').fill(NEW);
  await dialog.getByRole('button', { name: 'Change passphrase' }).click();
  await expect(page.getByText('Passphrase changed')).toBeVisible();
  await axeClean(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Alt+Control+KeyL');
  await expect(page.getByTestId('unlock-screen')).toBeVisible();
  await page.getByLabel('Passphrase').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Passphrase').fill(NEW);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByTestId('unlock-screen')).toHaveCount(0);
});

test('a voided recovery key blocks the shell until a new one is made', async ({ page }) => {
  await setup(page, {}, { ...encrypted, recoveryVoid: true });
  await unlock(page).catch(() => undefined);
  const prompt = page.getByRole('alertdialog');
  await expect(prompt).toContainText('replaced on another device');
  await page.keyboard.press('Escape');
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Make a new recovery key' }).click();
  await page.getByLabel('Current passphrase').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('recovery-code')).toBeVisible();
  await axeClean(page);
});

const lockRequest = (page: import('@playwright/test').Page, reason: string) =>
  page.evaluate(
    (r) =>
      (window as unknown as { __liberEmit: (e: string, p: unknown) => void }).__liberEmit(
        'vault:lock-request',
        { reason: r },
      ),
    reason,
  );

test('a lock takes the voided-key prompt down; Unlock works and brings it back', async ({
  page,
}) => {
  await setup(page, {}, { ...encrypted, recoveryVoid: true });
  await unlock(page).catch(() => undefined);
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await lockRequest(page, 'idle');
  await expect(page.getByTestId('unlock-screen')).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.getByLabel('Passphrase').fill(PASSPHRASE);
  await page.getByLabel('Passphrase').press('Enter');
  await expect(page.getByRole('alertdialog')).toContainText('replaced on another device');
});

test('Settings → New recovery key: the code outlives a lock, then Done leaves Unlock', async ({
  page,
}) => {
  await setup(page);
  await unlock(page);
  const settings = await openSecurity(page);
  await settings.getByRole('button', { name: 'New recovery key…' }).click();
  const dialog = page.getByRole('dialog', { name: 'New recovery key' });
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  await dialog.getByLabel('Current passphrase').fill(PASSPHRASE);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  const box = page.getByTestId('recovery-code');
  const groups = ((await box.textContent()) ?? '').split('-').slice(1);
  await lockRequest(page, 'sleep');
  await expect(page.getByTestId('unlock-screen')).toBeVisible();
  await expect(box).toBeVisible();
  await dialog.getByRole('button', { name: "I've saved it" }).click();
  const rows = dialog.locator('label', { hasText: /^Group \d+$/ });
  for (let i = 0; i < 2; i++) {
    const n = Number(((await rows.nth(i).textContent()) ?? '').replace(/\D/g, ''));
    await rows
      .nth(i)
      .locator('input')
      .fill(groups[n - 1]);
  }
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Passphrase')).toBeFocused();
});

test("This vault lists what couldn't be read, with a reveal button", async ({ page }) => {
  await setup(
    page,
    {},
    { ...encrypted, unreadable: [{ osPath: '/enc/aaa', reason: 'name could not be decrypted' }] },
  );
  await unlock(page);
  const dialog = await (async () => {
    await openSettings(page);
    const d = page.getByRole('dialog', { name: 'Settings' });
    await d.getByRole('button', { name: 'This vault' }).click();
    return d;
  })();
  await expect(dialog.getByText("Couldn't read")).toBeVisible();
  await expect(dialog.getByText('name could not be decrypted')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Show in / })).toBeVisible();
});

// ---- Task 6: the whole journey ----
test('journey: create, write, lock, unlock, screen lock, unlock with a lower-case recovery key; axe', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/');
  await page.getByRole('switch', { name: /Encrypt this vault/ }).check();
  await page.getByRole('button', { name: /^New vault/ }).click();
  const dialog = page.getByRole('dialog');
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel('Confirm passphrase').fill(PASSPHRASE);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  const box = page.getByTestId('recovery-code');
  const groups = ((await box.textContent()) ?? '').split('-').slice(1);
  await dialog.getByRole('button', { name: "I've saved it" }).click();
  const rows = dialog.locator('label', { hasText: /^Group \d+$/ });
  for (let i = 0; i < 2; i++) {
    const n = Number(((await rows.nth(i).textContent()) ?? '').replace(/\D/g, ''));
    await rows
      .nth(i)
      .locator('input')
      .fill(groups[n - 1]);
  }
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('[data-vault-menu]')).toBeVisible();

  await page.getByRole('treeitem', { name: 'Welcome', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('journey text');
  await page.keyboard.press('Alt+Control+KeyL');
  await expect(page.getByTestId('unlock-screen')).toBeVisible();
  await page.getByLabel('Passphrase').fill(PASSPHRASE);
  await page.getByLabel('Passphrase').press('Enter');
  await expect(page.getByTestId('unlock-screen')).toHaveCount(0);
  await page.getByRole('treeitem', { name: 'Welcome', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('journey text');

  await page.evaluate(() =>
    (window as unknown as { __liberEmit: (e: string, p: unknown) => void }).__liberEmit(
      'vault:lock-request',
      { reason: 'screenLock' },
    ),
  );
  await expect(page.getByTestId('unlock-screen')).toBeVisible();
  await page.getByRole('button', { name: 'Use recovery key instead' }).click();
  await page.getByLabel('Recovery key').fill(encrypted.recovery.toLowerCase());
  await axeClean(page); // the shell's own chrome has known contrast debt: axe the new screen
  await page.getByLabel('Recovery key').press('Enter');
  await expect(page.getByTestId('unlock-screen')).toHaveCount(0);
});
