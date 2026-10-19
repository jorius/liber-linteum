// M2c in the built UI, in Chromium and WebKit (≈ WKWebView): cover and
// subtitle editing, pasted images, dropped files (Tauri drag events), `[[`
// autocomplete, the ⌘K link picker and Create page with folders — all without
// a single request leaving the machine.
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const PAGES = {
  'A.md': '# Alpha\n\nhello world\n\nSee [[Ideas/New idea]].\n',
  'B.md': '# B\n\nThe second page.\n',
  'rex-draft.md': '# Generator Rex\n\nTeen agent.\n',
};

/** Requests that would leave the machine (the test server is 127.0.0.1). */
async function watchNetwork(page: Page) {
  const outside: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    const local =
      (url.protocol === 'http:' && url.hostname === '127.0.0.1') ||
      url.protocol === 'data:' ||
      // Vault files: nimw-asset://localhost (macOS, Linux), http://nimw-asset.localhost (Windows UA).
      url.protocol === 'nimw-asset:' ||
      url.hostname === 'nimw-asset.localhost';
    if (!local) outside.push(r.url());
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|nimw-asset\.localhost)/, (route) => route.abort());
  return outside;
}

async function open(page: Page, name: string) {
  const outside = await watchNetwork(page);
  await page.addInitScript(installIpcMock, {
    pages: { ...PAGES },
    editorMode: 'livePreview',
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue(name);
  return outside;
}

/** CSP violations: the sanitizer and the app must make none (M2a §7). */
const csp = (page: Page) =>
  page.evaluate(() => (window as unknown as { __nimwCspViolations: string[] }).__nimwCspViolations);

const lastWrite = (page: Page) =>
  page.evaluate(() => {
    const writes = (window as unknown as { __nimwWrites?: { text: string }[] }).__nimwWrites ?? [];
    return writes.at(-1)?.text ?? null;
  });

test('cover: add (straight into reposition, M4b §2), place with the keyboard, remove', async ({
  page,
}) => {
  const outside = await open(page, 'A');
  await page.getByRole('button', { name: 'Add cover' }).click();
  await expect
    .poll(() => lastWrite(page))
    .toMatch(/^---\ncover: attachments\/sky\.png\n---\n# Alpha/);
  const cover = page.getByRole('group', { name: 'Cover' });
  await expect(cover.locator('img[data-cover]')).toHaveAttribute('src', /\/attachments\/sky\.png$/);
  // A new cover opens in reposition mode at once: one Save position places it.
  await expect(page.getByRole('slider', { name: 'Cover position' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.getByRole('button', { name: 'Save position' }).click();
  await expect.poll(() => lastWrite(page)).toContain('cover-y: 45');
  await cover.getByRole('button', { name: 'Remove' }).click();
  await expect.poll(() => lastWrite(page)).toBe(PAGES['A.md']);
  await expect(page.getByRole('button', { name: 'Add cover' })).toBeAttached();
  expect(outside).toEqual([]);
  expect(await csp(page)).toEqual([]);
});

test('subtitle: type, Enter saves it to the frontmatter', async ({ page }) => {
  await open(page, 'B');
  const field = page.getByRole('textbox', { name: 'Subtitle' });
  await field.fill('Second thoughts');
  await field.press('Enter');
  await expect
    .poll(() => lastWrite(page))
    .toBe('---\nsubtitle: Second thoughts\n---\n# B\n\nThe second page.\n');
  await expect(field).toBeFocused();
});

test('a pasted image is saved and embedded at the cursor', async ({ page }) => {
  const outside = await open(page, 'B');
  await page.locator('.cm-line', { hasText: 'The second page.' }).click();
  await page.keyboard.press('End');
  await page.locator('.cm-content').evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }));
    const e = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: dt });
    el.dispatchEvent(e);
  });
  await expect
    .poll(() => lastWrite(page))
    .toMatch(/The second page\.!\[\[Pasted image \d{14}\.png\]\]/);
  const names = await page.evaluate(
    () => (window as unknown as { __nimwPastes?: string[] }).__nimwPastes,
  );
  expect(names).toEqual([expect.stringMatching(/^Pasted image \d{14}\.png$/)]);
  expect(outside).toEqual([]);
  expect(await csp(page)).toEqual([]);
});

test.describe('on a 2× screen', () => {
  test.use({ deviceScaleFactor: 2 });

  test('files dropped from the OS land where they were dropped', async ({ page }) => {
    const outside = await open(page, 'B');
    const line = page.locator('.cm-line', { hasText: 'The second page.' });
    const box = (await line.boundingBox())!;
    // Tauri's drag position is from the webview's corner: physical pixels from
    // WebView2 (Windows), CSS pixels from WKWebView and WebKitGTK (final review
    // C1). Chromium here has a Windows user agent, WebKit a macOS one.
    const ratio = await page.evaluate(() =>
      /^Win/i.test(navigator.platform) || /Windows/i.test(navigator.userAgent)
        ? window.devicePixelRatio
        : 1,
    );
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
    const at = { x: (box.x + 2) * ratio, y: (box.y + box.height / 2) * ratio };
    await page.evaluate((position) => {
      const emit = (window as unknown as { __nimwEmit: (e: string, p: unknown) => void })
        .__nimwEmit;
      emit('tauri://drag-enter', { paths: ['/Users/me/brief.pdf'], position });
      emit('tauri://drag-over', { position });
    }, at);
    await expect(page.locator('.cm-nimw-drop-caret')).toBeAttached();
    await page.evaluate((position) => {
      const emit = (window as unknown as { __nimwEmit: (e: string, p: unknown) => void })
        .__nimwEmit;
      emit('tauri://drag-drop', { paths: ['/Users/me/brief.pdf', '/Users/me/data.zip'], position });
    }, at);
    await expect
      .poll(() => lastWrite(page))
      .toContain('![[brief.pdf]]\n[[data.zip]]The second page.');
    await expect(page.locator('.cm-nimw-drop-caret')).toHaveCount(0);
    expect(outside).toEqual([]);
    expect(await csp(page)).toEqual([]);
  });
});

test('[[ autocomplete writes [[file|Title]] (PG-05)', async ({ page }) => {
  await open(page, 'B');
  await page.locator('.cm-line', { hasText: 'The second page.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' [[gen');
  const list = page.locator('.cm-tooltip-autocomplete');
  await expect(list).toContainText('Generator Rex');
  await page.waitForTimeout(100); // CodeMirror's interaction delay
  await page.keyboard.press('Enter');
  await expect
    .poll(() => lastWrite(page))
    .toContain('The second page. [[rex-draft|Generator Rex]]');
});

test('⌘K links the selection to a page through the picker', async ({ page }) => {
  await open(page, 'B');
  await page
    .locator('.cm-line', { hasText: 'The second page.' })
    .dblclick({ position: { x: 40, y: 5 } });
  await page.keyboard.press('ControlOrMeta+k');
  const picker = page.getByRole('combobox', { name: 'Link to…' });
  await expect(picker).toBeFocused();
  await picker.fill('alpha');
  await expect(page.getByRole('listbox', { name: 'Pages' }).getByRole('option')).toHaveCount(1);
  await picker.press('Enter');
  await expect.poll(() => lastWrite(page)).toMatch(/\[\[A\|\w+\]\]/);
});

test('Create page for [[Ideas/New idea]] creates the folder and opens the page', async ({
  page,
}) => {
  await open(page, 'A');
  await page.locator('.cm-nimw-link', { hasText: 'Ideas/New idea' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create page “New idea” in Ideas/?' });
  await dialog.getByRole('button', { name: 'Create page' }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('New idea');
});
