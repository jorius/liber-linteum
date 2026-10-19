// M4b part 3, files and links, in the built UI in Chromium and WebKit
// (≈ WKWebView): the Attach button's Copy-or-Link choice (§7), the link
// format for new attachments and where attachments are on disk (§8), and
// files outside the vault (§9) — without a single request leaving the
// machine.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

const PAGES = {
  'A.md': '# Alpha\n\nhello world\n',
  'Pics.md':
    '# Pics\n\n![[attachments/sky.png]]\n\n![[/Users/j/pic.png]]\n\n![[D:\\Docs\\gone.pdf]]\n',
  'Net.md': '# Net\n\n![[\\\\nas\\share\\x.png]]\n',
};

/** A file on another computer, as `links_external` reports it before and
 *  after the user loads it (final review C1). */
const NAS = '\\\\nas\\share\\x.png';

const pick = (name: string) => ({
  path: `/Users/u/${name}`,
  name,
  url: `file:///Users/u/${encodeURIComponent(name)}`,
  inVault: null,
});

/** Requests that would leave the machine (the test server is 127.0.0.1). */
async function watchNetwork(page: Page) {
  const outside: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    const local =
      (url.protocol === 'http:' && url.hostname === '127.0.0.1') ||
      url.protocol === 'data:' ||
      url.protocol === 'nimw-asset:' ||
      url.hostname === 'nimw-asset.localhost';
    if (!local) outside.push(r.url());
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|nimw-asset\.localhost)/, (route) => route.abort());
  return outside;
}

async function open(page: Page, name: string, settings: Record<string, unknown> = {}) {
  const outside = await watchNetwork(page);
  await page.addInitScript(installIpcMock, {
    pages: { ...PAGES },
    editorMode: 'livePreview',
    remoteCover: false,
    files: ['attachments/sky.png'],
    settings,
    outside: {
      '/Users/j/pic.png': { path: '/Users/j/pic.png', exists: true, listed: true },
      'D:\\Docs\\gone.pdf': { path: 'D:\\Docs\\gone.pdf', exists: false, listed: true },
      [NAS]: { path: NAS, exists: false, listed: true, network: true, askFirst: true },
    },
    filePicks: [pick('my pic.png'), pick('notes.zip')],
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue(name);
  return outside;
}

async function stayedLocal(page: Page, outside: string[]) {
  await page.waitForLoadState('networkidle');
  expect(outside).toEqual([]);
  expect(
    await page.evaluate(
      () => (window as unknown as { __nimwCspViolations: string[] }).__nimwCspViolations,
    ),
  ).toEqual([]);
}

const lastWrite = (page: Page) =>
  page.evaluate(() => {
    const writes = (window as unknown as { __nimwWrites?: { text: string }[] }).__nimwWrites ?? [];
    return writes.at(-1)?.text ?? null;
  });

async function axeViolations(page: Page, selector: string): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async (sel) => {
    const { axe } = window as unknown as {
      axe: {
        run: (
          el: Element,
          o: object,
        ) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
      };
    };
    const res = await axe.run(document.querySelector(sel)!, {
      resultTypes: ['violations'],
      // Pre-existing (M2b feedback round): the "Format" button is named
      // "Formatting toolbar"; not part of this milestone.
      rules: { 'label-content-name-mismatch': { enabled: false } },
    });
    return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`);
  }, selector);
}

/** The cursor at the end of "hello world". */
async function cursorAfterHello(page: Page) {
  await page.locator('.cm-line', { hasText: 'hello world' }).click();
  await page.keyboard.press('End');
}

test.use({ viewport: { width: 1280, height: 900 } });

test('§7 Attach → Copy into the vault embeds the copies', async ({ page }) => {
  const outside = await open(page, 'A');
  await cursorAfterHello(page);
  await page.getByRole('button', { name: 'Attach a file or image…' }).click();
  const choice = page.getByRole('dialog', { name: 'Attach 2 files' });
  await expect(choice).toBeVisible();
  await expect(choice.getByRole('button', { name: 'Copy into the vault' })).toBeFocused();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await axeViolations(page, '[role="dialog"]'), scheme).toEqual([]);
  }
  await page.keyboard.press('Enter');
  await expect
    .poll(() => lastWrite(page))
    .toBe('# Alpha\n\nhello world![[my pic.png]]\n[[notes.zip]]\n');
  await expect(choice).toBeHidden();
  await stayedLocal(page, outside);
});

test('§7 Attach → Link to where it is writes file: URLs; Escape cancels', async ({ page }) => {
  const outside = await open(page, 'A');
  await cursorAfterHello(page);
  await page.getByRole('button', { name: 'Attach a file or image…' }).click();
  await page.getByRole('button', { name: 'Link to where it is' }).click();
  await expect
    .poll(() => lastWrite(page))
    .toBe(
      '# Alpha\n\nhello world![](file:///Users/u/my%20pic.png)\n[notes.zip](file:///Users/u/notes.zip)\n',
    );
  await page.getByRole('button', { name: 'Attach a file or image…' }).click();
  await expect(page.getByRole('dialog', { name: 'Attach 2 files' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Attach 2 files' })).toBeHidden();
  await expect(page.locator('.cm-content')).toBeFocused();
  await stayedLocal(page, outside);
});

test('§8 the link format for new attachments, in Settings → This vault', async ({ page }) => {
  const outside = await open(page, 'A');
  await page.getByRole('button', { name: 'Settings' }).click();
  const format = page.getByRole('combobox', { name: 'Link format for new attachments' });
  await expect(format).toHaveValue('shortest');
  await expect(page.getByText('![[x.png]]')).toBeVisible();
  await format.selectOption('absolute');
  await expect(page.getByText('![](file:///…/Assets/x.png)')).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { __nimwVaultPatches: unknown[] }).__nimwVaultPatches,
    ),
  ).toEqual([{ attachmentLinkFormat: 'absolute' }]);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await axeViolations(page, '[role="dialog"]'), scheme).toEqual([]);
  }
  await stayedLocal(page, outside);
});

test('§9 outside files and §8 where attachments are on disk', async ({ page }) => {
  const outside = await open(page, 'Pics', { showAttachmentPaths: true });
  const pic = page.getByRole('img', { name: '/Users/j/pic.png' }).last();
  // nimw-asset://localhost/… (macOS), http://nimw-asset.localhost/… (a Windows UA).
  await expect(pic).toHaveAttribute('src', /nimw-asset.*\/\.external\/%2FUsers%2Fj%2Fpic\.png$/);
  await expect(page.getByText('Not found: D:\\Docs\\gone.pdf').last()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create page' })).toHaveCount(0);
  // Captions: the vault file under the vault's folder, the outside one as is.
  // Chromium's Desktop Chrome profile has a Windows UA: Windows separators.
  const windows = await page.evaluate(() => /Windows/i.test(navigator.userAgent));
  const sky = windows ? '/vault\\attachments\\sky.png' : '/vault/attachments/sky.png';
  await expect(page.getByText(sky, { exact: true }).last()).toBeVisible();
  await expect(page.getByText('/Users/j/pic.png', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy path' }).first()).toBeVisible();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await axeViolations(page, 'main'), scheme).toEqual([]);
  }
  await stayedLocal(page, outside);
});

test('§9 a network file waits for the user, then loads (final review C1)', async ({ page }) => {
  const outside = await open(page, 'Net');
  await expect(page.getByText(`Network file: ${NAS}`).last()).toBeVisible();
  await expect(page.getByText('Loading it connects to “nas”.').last()).toBeVisible();
  await expect(page.getByRole('img', { name: NAS })).toHaveCount(0);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await axeViolations(page, 'main'), scheme).toEqual([]);
  }
  expect(
    await page.evaluate(
      () => (window as unknown as { __nimwNetworkLoads?: string[] }).__nimwNetworkLoads,
    ),
  ).toBeUndefined();
  await page.getByRole('button', { name: 'Load from network' }).last().click();
  await expect(page.getByRole('img', { name: NAS }).last()).toHaveAttribute(
    'src',
    /nimw-asset.*\/\.external\/%5C%5Cnas%5Cshare%5Cx\.png$/,
  );
  expect(
    await page.evaluate(
      () => (window as unknown as { __nimwNetworkLoads?: string[] }).__nimwNetworkLoads,
    ),
  ).toEqual([NAS]);
  await stayedLocal(page, outside);
});
