// Encryption UX §9 (encrypt in place: keep a readable backup) and §10
// (Decrypt "<vault>" in place), through the mock backend, with axe on every
// step, in light and dark.
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const PASSPHRASE = 'correct horse battery';
const RECOVERY = 'LIBER-AAAA-BBBB';
const BACKUP = '/e2e/backup';

type Opts = Parameters<typeof installIpcMock>[0];

const setup = (
  page: Page,
  theme: string,
  extra: Pick<Opts, 'encryptInPlace' | 'decryptInPlace'> = {},
) =>
  page.addInitScript(installIpcMock, {
    settings: { theme },
    pages: { 'Welcome.md': '# Welcome\n\nStart here.\n' },
    editorMode: 'livePreview',
    remoteCover: false,
    encrypted: { passphrase: PASSPHRASE, recovery: RECOVERY },
    ...extra,
  });

const axeClean = async (page: Page, scope = '[role="dialog"]') => {
  await page.evaluate(AXE);
  const violations = await page.evaluate(async (sel) => {
    const { axe } = window as unknown as {
      axe: {
        run: (
          el: Element,
          opts: object,
        ) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
      };
    };
    const res = await axe.run(document.querySelector(sel)!, { resultTypes: ['violations'] });
    return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`);
  }, scope);
  expect(violations).toEqual([]);
};

const win = (page: Page, key: string) =>
  page.evaluate((k) => (window as unknown as Record<string, unknown>)[k], key);

/** Welcome → the encrypted vault `/enc`, unlocked. */
async function unlockEnc(page: Page) {
  await page.getByRole('button', { name: /^enc Encrypted/ }).click();
  await page.getByLabel('Passphrase').fill(PASSPHRASE);
  await page.getByLabel('Passphrase').press('Enter');
  await expect(page.locator('[data-vault-menu]')).toBeVisible();
}

async function openDecrypt(page: Page) {
  await page.locator('[data-vault-menu]').click();
  await page.getByRole('menuitem', { name: 'Decrypt “enc”…' }).click();
  return page.getByRole('dialog', { name: 'Decrypt “enc”' });
}

async function toSecrets(dialog: Locator) {
  await expect(dialog.getByText(/2 files\./)).toBeVisible();
  await dialog.getByRole('button', { name: 'Continue' }).click();
}

/** Types back the two groups the key step asks for, from the code shown. */
async function confirmKey(dialog: Locator) {
  const code = (await dialog.getByTestId('recovery-code').textContent()) ?? '';
  await dialog.getByRole('button', { name: "I've saved it" }).click();
  for (const input of await dialog.getByRole('textbox').all()) {
    const label = (await input.evaluate((el) => el.closest('label')?.textContent)) ?? '';
    const n = Number(/Group (\d+)/.exec(label)![1]);
    await input.fill(code.split('-')[n]);
  }
  await dialog.getByRole('button', { name: 'Done' }).click();
}

for (const theme of ['light', 'dark'] as const) {
  test(`Decrypt: intro, both secrets, progress, done, a plain vault (${theme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await setup(page, theme, { decryptInPlace: { holdRun: true } });
    await page.goto('/');
    await unlockEnc(page);
    await expect.poll(() => win(page, '__liberDecryptItem')).toBe('enc');
    const dialog = await openDecrypt(page);
    await expect(dialog.locator('.liber-chip')).toHaveText('Beta');
    await expect(dialog.getByText(/anyone with access to this disk/)).toBeVisible();
    await expect(dialog.getByText(/stop working for good/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Continue' })).toBeFocused();
    await axeClean(page);
    await toSecrets(dialog);
    const decrypt = dialog.getByRole('button', { name: 'Decrypt' });
    await expect(decrypt).toBeDisabled();
    await dialog.getByLabel('Passphrase', { exact: true }).fill('not the passphrase');
    await dialog.getByLabel('Recovery key').fill(RECOVERY);
    await axeClean(page);
    await decrypt.click();
    await expect(dialog.getByRole('alert')).toHaveText("The passphrase doesn't open this vault.");
    await expect(dialog.getByLabel('Recovery key')).toHaveValue(RECOVERY);
    await axeClean(page);
    await dialog.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await dialog.getByLabel('Recovery key').fill('LIBER-WRONG');
    await decrypt.click();
    await expect(dialog.getByRole('alert')).toHaveText("The recovery key doesn't open this vault.");
    await dialog.getByLabel('Recovery key').fill(RECOVERY);
    await dialog.getByRole('button', { name: 'Decrypt' }).click();
    await expect(
      dialog.getByText('1 of 2 files · each one is checked before anything encrypted is removed'),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Stop and undo' })).toBeFocused();
    await axeClean(page);
    // Held: Escape leaves it up.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { __liberFinishDecrypt: () => void }).__liberFinishDecrypt(),
    );
    await expect(dialog.getByText(/2 files decrypted and checked\./)).toBeVisible();
    await axeClean(page);
    await dialog.getByRole('button', { name: 'Open' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('[data-vault-menu]')).toBeVisible();
    // A plain vault now: Encrypt is offered, Decrypt and Lock are not.
    await expect.poll(() => win(page, '__liberDecryptItem')).toBeNull();
    await expect.poll(() => win(page, '__liberEncryptItem')).toBe('enc');
    await page.locator('[data-vault-menu]').click();
    await expect(page.getByRole('menuitem', { name: 'Encrypt “enc”…' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Lock vault' })).toHaveCount(0);
  });

  test(`Decrypt: Stop and undo leaves it encrypted, at the Unlock screen (${theme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await setup(page, theme, { decryptInPlace: { holdRun: true } });
    await page.goto('/');
    await unlockEnc(page);
    const dialog = await openDecrypt(page);
    await toSecrets(dialog);
    await dialog.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await dialog.getByLabel('Recovery key').fill(RECOVERY);
    await dialog.getByRole('button', { name: 'Decrypt' }).click();
    await dialog.getByRole('button', { name: 'Stop and undo' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Stopped. The vault is back as it was.');
    await axeClean(page);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('unlock-screen')).toBeVisible();
  });

  test(`Decrypt: a blocked preflight lists what stops it (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await setup(page, theme, {
      decryptInPlace: { blocked: [{ path: 'Notes.md', reason: 'taken' }] },
    });
    await page.goto('/');
    await unlockEnc(page);
    const dialog = await openDecrypt(page);
    await expect(dialog.getByText('Notes.md')).toBeVisible();
    await expect(dialog.getByText(/beside the vault already has this name/)).toBeVisible();
    await expect(dialog.getByRole('button')).toHaveText(['Close']);
    await axeClean(page);
  });

  test(`Encrypt with a readable backup: chosen, copied, then the key, then done (${theme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await setup(page, theme, { encryptInPlace: { holdBackup: true } });
    await page.goto('/');
    await page.getByRole('button', { name: /^vault/ }).click();
    await page.locator('[data-vault-menu]').click();
    await page.getByRole('menuitem', { name: 'Encrypt “vault”…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Encrypt “vault”' });
    await dialog.getByRole('button', { name: 'Continue' }).click();
    const next = dialog.getByRole('button', { name: 'Choose a passphrase…' });
    await expect(next).toBeDisabled();
    await axeClean(page);
    await dialog.getByRole('radio', { name: 'Keep a readable copy' }).check();
    await expect(dialog.getByText(/The copy is not encrypted/)).toBeVisible();
    await expect(next).toBeDisabled();
    await dialog.getByRole('button', { name: 'Choose…' }).click();
    await expect(dialog.getByText(BACKUP)).toBeVisible();
    await expect(next).toBeEnabled();
    await axeClean(page);
    await next.click();
    await dialog.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await dialog.getByLabel('Confirm passphrase').fill(PASSPHRASE);
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expect(dialog.getByText(/files copied · each copy is checked/)).toBeVisible();
    await expect(dialog.getByTestId('recovery-code')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Stop and undo' })).toBeFocused();
    await axeClean(page);
    await page.evaluate(() =>
      (window as unknown as { __liberFinishBackup: () => void }).__liberFinishBackup(),
    );
    await expect(dialog.getByTestId('recovery-code')).toBeVisible();
    await confirmKey(dialog);
    await expect(dialog.getByText(/A readable copy is in this folder/)).toBeVisible();
    await expect(dialog.getByText(BACKUP)).toBeVisible();
    await axeClean(page);
    await dialog.getByRole('button', { name: /^Show in / }).click();
    await expect.poll(() => win(page, '__liberReveals')).toEqual(['backup']);
  });

  test(`Encrypt: a refused backup folder says why (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await setup(page, theme, {
      encryptInPlace: {
        backupRefusal: { kind: 'backupInOtherVault', message: '/e2e/other' },
      },
    });
    await page.goto('/');
    await page.getByRole('button', { name: /^vault/ }).click();
    await page.locator('[data-vault-menu]').click();
    await page.getByRole('menuitem', { name: 'Encrypt “vault”…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Encrypt “vault”' });
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await dialog.getByRole('radio', { name: 'Keep a readable copy' }).check();
    await dialog.getByRole('button', { name: 'Choose…' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      'That folder is inside the vault /e2e/other. Pick a folder outside any vault.',
    );
    await expect(dialog.getByRole('button', { name: 'Choose a passphrase…' })).toBeDisabled();
    await axeClean(page);
  });
}
