// Encryption UX round: the New vault dialog (§2), the recent list's Encrypted
// chip (§3), Vault → Encrypt (§4.1) and the one Beta chip (§5).
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';
import { openSettings } from './shell';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const PASSPHRASE = 'correct horse battery';
const PICKED = '/e2e/new-encrypted';

const setup = (page: Page, folderKinds: Record<string, string> = {}, theme = 'light') =>
  page.addInitScript(installIpcMock, {
    settings: { theme },
    pages: { 'Welcome.md': '# Welcome\n\nStart here.\n' },
    editorMode: 'livePreview',
    remoteCover: false,
    encrypted: { passphrase: PASSPHRASE, recovery: 'LIBER-AAAA-BBBB' },
    folderKinds,
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
  await expect(page.getByText('Encrypting in place is coming in the next step.')).toBeVisible();
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
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Encrypting in place is coming in the next step.')).toBeVisible();
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
