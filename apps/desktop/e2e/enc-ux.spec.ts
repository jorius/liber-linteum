// Encryption UX round: the New vault dialog (§2), the recent list's Encrypted
// chip (§3), Vault → Encrypt (§4.1) and the one Beta chip (§5).
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';
import { openSettings } from './shell';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const PASSPHRASE = 'correct horse battery';
const PICKED = '/e2e/new-encrypted';

const setup = (
  page: Page,
  folderKinds: Record<string, string> = {},
  theme = 'light',
  encryptInPlace: Parameters<typeof installIpcMock>[0]['encryptInPlace'] = {},
) =>
  page.addInitScript(installIpcMock, {
    settings: { theme },
    pages: { 'Welcome.md': '# Welcome\n\nStart here.\n' },
    editorMode: 'livePreview',
    remoteCover: false,
    encrypted: { passphrase: PASSPHRASE, recovery: 'LIBER-AAAA-BBBB' },
    folderKinds,
    encryptInPlace,
  });

const axeClean = async (page: Page, scope: string) => {
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

/** §5: 18 px high, on the line of the word before it, 8 px after it. */
const chipFits = async (chip: Locator) => {
  const geo = await chip.evaluate((el) => {
    let prev = el.previousSibling;
    while (prev && prev.nodeType === Node.TEXT_NODE && !prev.textContent?.trim()) {
      prev = prev.previousSibling;
    }
    const range = document.createRange();
    range.selectNodeContents(prev!);
    const word = range.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return {
      height: box.height,
      gap: box.left - word.right,
      centres: Math.abs(box.top + box.height / 2 - (word.top + word.height / 2)),
      marginLeft: getComputedStyle(el).marginLeft,
    };
  });
  expect(geo.height).toBe(18);
  expect(geo.marginLeft).toBe('8px');
  expect(geo.gap).toBeGreaterThanOrEqual(7.5);
  expect(geo.gap).toBeLessThanOrEqual(9);
  expect(geo.centres).toBeLessThanOrEqual(3);
};

/** The pill reads even on an accent-soft background like its own: a ring. */
const chipRinged = async (chip: Locator) => {
  const { shadow, bg, parentBg } = await chip.evaluate((el) => {
    let p = el.parentElement;
    while (p && getComputedStyle(p).backgroundColor === 'rgba(0, 0, 0, 0)') p = p.parentElement;
    return {
      shadow: getComputedStyle(el).boxShadow,
      bg: getComputedStyle(el).backgroundColor,
      parentBg: p ? getComputedStyle(p).backgroundColor : '',
    };
  });
  expect(bg).toBe(parentBg); // the case the ring is for
  expect(shadow).toMatch(/inset/);
  expect(shadow).toMatch(/1px/);
  const colour = /rgba?\([^)]*\)/.exec(shadow)?.[0] ?? '';
  expect(colour).not.toBe('');
  expect(colour).not.toMatch(/,\s*0\)$/);
  expect(colour).not.toBe(bg);
};

const newVault = async (page: Page) => {
  await page.getByRole('button', { name: /^New vault/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New vault' });
  await expect(dialog.getByText(PICKED)).toBeVisible();
  return dialog;
};

test('New vault, Plain (the default): creates the vault and names it in Vault → Encrypt', async ({
  page,
}) => {
  await setup(page, { [PICKED]: 'missing' });
  await page.goto('/');
  const dialog = await newVault(page);
  await expect(dialog.getByRole('radio', { name: 'Plain', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('[data-vault-menu]')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as Record<string, unknown>).__liberEncryptItem),
    )
    .toBe('new-encrypted');
  // The sidebar's vault menu has the same item.
  await page.locator('[data-vault-menu]').click();
  await page.getByRole('menuitem', { name: 'Encrypt “new-encrypted”…' }).click();
  await expect(page.getByRole('dialog', { name: 'Encrypt “new-encrypted”' })).toBeVisible();
});

test('New vault, Encrypted, on an empty folder: through to the recovery key', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  const dialog = await newVault(page);
  await dialog.getByRole('radio', { name: 'Encrypted Beta', exact: true }).check();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(dialog.getByText('1 Passphrase')).toHaveAttribute('aria-current', 'step');
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel('Confirm passphrase').fill(PASSPHRASE);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('recovery-code')).toBeVisible();
  await expect(dialog.getByText('2 Recovery key')).toHaveAttribute('aria-current', 'step');
  await expect(page.getByRole('dialog', { name: 'New vault' })).toBeVisible();
  await axeClean(page, '[role="dialog"]');
  // An encrypted vault never offers Encrypt.
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as Record<string, unknown>).__liberEncryptItem),
    )
    .toBeNull();
});

test('New vault, Encrypted, on a folder with notes: the in-place offer', async ({ page }) => {
  await setup(page, { [PICKED]: 'plain' });
  await page.goto('/');
  const dialog = await newVault(page);
  await dialog.getByRole('radio', { name: 'Encrypted Beta', exact: true }).check();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(
    dialog.getByText('This folder already has notes. Encrypt it in place?'),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Encrypt in place…' })).toBeFocused();
  await axeClean(page, '[role="dialog"]');
  await dialog.getByRole('button', { name: 'Encrypt in place…' }).click();
  const encrypt = page.getByRole('dialog', { name: 'Encrypt “new-encrypted”' });
  await expect(encrypt.getByText(/will be encrypted where it is\. 1 file\./)).toBeVisible();
  await expect(encrypt.getByRole('button', { name: 'Continue' })).toBeFocused();
});

for (const theme of ['light', 'dark'] as const) {
  test(`the New vault dialog is axe-clean and its Beta chip sits right (${theme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await setup(page, {}, theme);
    await page.goto('/');
    const dialog = await newVault(page);
    await axeClean(page, '[role="dialog"]');
    await chipFits(dialog.locator('.liber-chip'));
    await dialog.getByRole('radio', { name: 'Encrypted Beta', exact: true }).check();
    await chipRinged(dialog.locator('.liber-chip')); // on the selected card
    await axeClean(page, '[role="dialog"]');
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await chipFits(dialog.locator('.liber-chip')); // beside the title
  });

  test(`the recent list's Encrypted chip, and the Beta chips on Unlock and in Settings (${theme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await setup(page, {}, theme);
    await page.goto('/');
    const row = page.getByRole('button', { name: /^enc Encrypted/ });
    const chip = row.locator('.liber-chip');
    await expect(chip).toHaveText('Encrypted');
    await chipFits(chip);
    await axeClean(page, '[aria-labelledby="welcome-recent"]');
    // As the most recent vault, its row is accent-soft too.
    await row.evaluate((el) => el.closest('li')!.setAttribute('data-latest', ''));
    await page.mouse.move(0, 0);
    await chipRinged(chip);
    await row.click();
    await chipFits(page.getByTestId('unlock-screen').locator('.liber-chip'));
    await page.getByLabel('Passphrase').fill(PASSPHRASE);
    await page.getByLabel('Passphrase').press('Enter');
    await expect(page.locator('[data-vault-menu]')).toBeVisible();
    await openSettings(page);
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: /^Security/ }).click();
    await chipFits(settings.locator('[data-nav="security"] .liber-chip'));
    await chipFits(settings.locator('h3 .liber-chip'));
  });
}

// ---- Encrypt in place (encryption UX §4.2 as amended by §8) ----

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

/** Intro → "Don't keep a copy" (§9) → the passphrase step. */
async function toPassphrase(dialog: Locator) {
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await dialog.getByRole('radio', { name: "Don't keep a copy" }).check();
  await dialog.getByRole('button', { name: 'Choose a passphrase…' }).click();
}

/** Vault menu → Encrypt "vault"… (from Welcome, `fromWelcome`, opening it first). */
const openPlainVault = async (page: Page, fromWelcome = true) => {
  if (fromWelcome) await page.getByRole('button', { name: /^vault/ }).click();
  await page.locator('[data-vault-menu]').click();
  await page.getByRole('menuitem', { name: 'Encrypt “vault”…' }).click();
  return page.getByRole('dialog', { name: 'Encrypt “vault”' });
};

for (const theme of ['light', 'dark'] as const) {
  test(`Vault → Encrypt: intro, passphrase, recovery key, progress, done, the shell (${theme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await setup(page, {}, theme, { holdRun: true });
    await page.goto('/');
    const dialog = await openPlainVault(page);
    await expect(dialog.getByText(/1 file\./)).toBeVisible();
    await expect(dialog.getByText(/Pause Dropbox, iCloud or other sync/)).toBeVisible();
    await chipFits(dialog.locator('.liber-chip'));
    await axeClean(page, '[role="dialog"]');
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await axeClean(page, '[role="dialog"]');
    await dialog.getByRole('radio', { name: "Don't keep a copy" }).check();
    await dialog.getByRole('button', { name: 'Choose a passphrase…' }).click();
    await expect(dialog.getByLabel('Passphrase', { exact: true })).toBeFocused();
    await dialog.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await dialog.getByLabel('Confirm passphrase').fill(PASSPHRASE);
    await axeClean(page, '[role="dialog"]');
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expect(dialog.getByTestId('recovery-code')).toBeVisible();
    await axeClean(page, '[role="dialog"]');
    // Held: Escape doesn't dismiss the key.
    await page.keyboard.press('Escape');
    await expect(dialog.getByTestId('recovery-code')).toBeVisible();
    await confirmKey(dialog);
    await expect(
      dialog.getByText('1 of 1 files · each one is checked before the original is moved'),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Stop and undo' })).toBeFocused();
    await axeClean(page, '[role="dialog"]');
    await page.evaluate(() =>
      (window as unknown as { __liberFinishEncrypt: () => void }).__liberFinishEncrypt(),
    );
    await expect(dialog.getByText(/1 file encrypted and checked\./)).toBeVisible();
    await axeClean(page, '[role="dialog"]');
    await dialog.getByRole('button', { name: 'Open' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('[data-vault-menu]')).toBeVisible();
    // Now encrypted: Encrypt is off.
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as Record<string, unknown>).__liberEncryptItem),
      )
      .toBeNull();
  });

  test(`a blocked preflight lists what stops it, and changes nothing (${theme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await setup(page, {}, theme, {
      blocked: [
        { path: 'a:b.md', reason: 'badChar' },
        { path: '.git', reason: 'git' },
      ],
    });
    await page.goto('/');
    const dialog = await openPlainVault(page);
    await expect(dialog.getByText('a:b.md')).toBeVisible();
    await expect(dialog.getByText('Rename or remove these, then try again.')).toBeVisible();
    await expect(dialog.getByRole('button')).toHaveText(['Close']);
    await axeClean(page, '[role="dialog"]');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('[data-vault-menu]')).toBeVisible();
  });

  test(`Stop and undo puts the plain vault back; originals the Trash refused get a banner (${theme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await setup(page, {}, theme, { holdRun: true, originalsPending: true });
    await page.goto('/');
    let dialog = await openPlainVault(page);
    const toKey = async () => {
      await toPassphrase(dialog);
      await dialog.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
      await dialog.getByLabel('Confirm passphrase').fill(PASSPHRASE);
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await confirmKey(dialog);
    };
    // Cancel at the recovery-key step: nothing was copied, the vault is back.
    await toPassphrase(dialog);
    await dialog.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await dialog.getByLabel('Confirm passphrase').fill(PASSPHRASE);
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Stopped. The vault is back as it was.');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('[data-vault-menu]')).toBeVisible();
    dialog = await openPlainVault(page, false);
    await toKey();
    await dialog.getByRole('button', { name: 'Stop and undo' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Stopped. The vault is back as it was.');
    await axeClean(page, '[role="dialog"]');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('[data-vault-menu]')).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as Record<string, unknown>).__liberEncryptItem),
      )
      .toBe('vault');

    dialog = await openPlainVault(page, false);
    await toKey();
    await page.evaluate(() =>
      (window as unknown as { __liberFinishEncrypt: () => void }).__liberFinishEncrypt(),
    );
    await expect(dialog.getByText(/still in the vault folder/)).toBeVisible();
    await axeClean(page, '[role="dialog"]');
    await dialog.getByRole('button', { name: 'Open' }).click();
    const banner = page.getByText(
      'The unencrypted originals of this vault are still in its folder.',
    );
    await expect(banner).toBeVisible();
    await axeClean(page, '[data-banner="originals"]');
    await page.getByRole('button', { name: 'Move to Trash' }).click();
    await expect(banner).toHaveCount(0);
  });
}
