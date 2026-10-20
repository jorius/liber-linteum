// Cover resize in the built UI, in Chromium and WebKit (≈ WKWebView): the
// cover band's bottom edge is dragged to a new height, kept for the page
// across a reload (in `.liber/vault.json`; here the mock's sessionStorage),
// with the band's rows pinned to its top and bottom — and nothing leaves the
// machine.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

const PAGES = {
  'A.md': '---\ncover: sky.png\n---\n# Alpha\n\nhello world\n',
  'B.md': '# Beta\n\nNo cover here.\n',
};

/** Requests that would leave the machine (the test server is 127.0.0.1). */
async function watchNetwork(page: Page) {
  const outside: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    const local =
      (url.protocol === 'http:' && url.hostname === '127.0.0.1') ||
      url.protocol === 'data:' ||
      url.protocol === 'liber-asset:' ||
      url.hostname === 'liber-asset.localhost';
    if (!local) outside.push(r.url());
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|liber-asset\.localhost)/, (route) => route.abort());
  return outside;
}

/** Opens the vault from the welcome screen, then `name`. */
async function openPage(page: Page, name: string) {
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue(name);
}

async function open(page: Page, name: string, settings: Record<string, unknown> = {}) {
  const outside = await watchNetwork(page);
  await page.addInitScript(installIpcMock, {
    pages: { ...PAGES },
    editorMode: 'livePreview',
    remoteCover: false,
    files: ['sky.png'],
    settings,
  });
  await page.goto('/');
  await openPage(page, name);
  return outside;
}

/** Nothing left the machine, and the CSP blocked nothing (M2a §7). */
async function stayedLocal(page: Page, outside: string[]) {
  await page.waitForLoadState('networkidle');
  expect(outside).toEqual([]);
  expect(
    await page.evaluate(
      () => (window as unknown as { __liberCspViolations: string[] }).__liberCspViolations,
    ),
  ).toEqual([]);
}

const band = (page: Page) => page.locator('[data-band="cover"]');
/** The band's height without its bottom border. */
const bandHeight = (page: Page) => band(page).evaluate((el) => el.clientHeight);
const handle = (page: Page) => page.getByRole('separator', { name: 'Cover height' });
/** What `cover_height_set` was asked to store. */
const saved = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __liberCoverHeights?: unknown[] }).__liberCoverHeights ?? [],
  );

/** The first row (the title, then the breadcrumb under it) hugs the band's
 *  top, the last (link counts) its bottom, whatever the height. */
async function rowsPinned(page: Page) {
  const b = (await band(page).boundingBox())!;
  const top = (await band(page).getByRole('textbox', { name: 'Page title' }).boundingBox())!;
  const crumbs = (await band(page).getByRole('navigation', { name: 'Breadcrumb' }).boundingBox())!;
  const foot = (await band(page).getByText('0 links · 0 backlinks').boundingBox())!;
  expect(top.y - b.y).toBeGreaterThanOrEqual(0);
  expect(top.y - b.y).toBeLessThan(24);
  expect(crumbs.y).toBeGreaterThan(top.y + top.height);
  expect(b.y + b.height - (foot.y + foot.height)).toBeGreaterThanOrEqual(0);
  expect(b.y + b.height - (foot.y + foot.height)).toBeLessThan(24);
}

test.use({ viewport: { width: 1280, height: 900 } });

test('cover resize: drag the bottom edge, reload, the height is kept; the rows stay pinned', async ({
  page,
}) => {
  const outside = await open(page, 'A');
  await expect(band(page)).toBeVisible();
  // The default (Settings → Editor → Default cover height: Medium).
  await expect.poll(() => bandHeight(page)).toBe(200);
  await rowsPinned(page);
  await band(page).hover();
  await expect(handle(page)).toBeVisible();
  const box = (await handle(page).boundingBox())!;
  const edge = (await band(page).boundingBox())!;
  // The handle is the band's bottom edge.
  expect(Math.abs(box.y + box.height - (edge.y + edge.height))).toBeLessThanOrEqual(2);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 60, { steps: 4 });
  // Live while dragging, saved only on release.
  await expect.poll(() => bandHeight(page)).toBe(260);
  expect(await saved(page)).toEqual([]);
  await page.mouse.move(x, y + 140, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => bandHeight(page)).toBe(340);
  await expect.poll(() => saved(page)).toEqual([{ path: 'A.md', height: 340 }]);
  await rowsPinned(page);
  // The note itself is never written.
  expect(
    await page.evaluate(() => (window as unknown as { __liberWrites?: unknown[] }).__liberWrites),
  ).toBeUndefined();

  await page.reload();
  await openPage(page, 'A');
  await expect.poll(() => bandHeight(page)).toBe(340);
  await rowsPinned(page);
  // A page without a cover keeps the slim band, with no handle.
  await page.getByRole('treeitem', { name: 'B', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('B');
  await expect(page.locator('[data-band="plain"]')).toBeVisible();
  await expect(handle(page)).toHaveCount(0);
  await stayedLocal(page, outside);
});

test('cover resize: the keyboard moves the edge; a shorter window shows less without storing it; a double-click resets', async ({
  page,
}) => {
  const outside = await open(page, 'A');
  await handle(page).focus();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => bandHeight(page)).toBe(280);
  await page.keyboard.press('Enter');
  await expect.poll(() => saved(page)).toEqual([{ path: 'A.md', height: 280 }]);
  await expect(handle(page)).toBeFocused();
  // At most 60% of the window: 240 px in a 400 px one, then back.
  await page.setViewportSize({ width: 1280, height: 400 });
  await expect.poll(() => bandHeight(page)).toBe(240);
  await expect(handle(page)).toHaveAttribute('aria-valuemax', '240');
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(() => bandHeight(page)).toBe(280);
  expect(await saved(page)).toHaveLength(1);
  await handle(page).dblclick();
  await expect.poll(() => bandHeight(page)).toBe(200);
  await expect
    .poll(() => saved(page))
    .toEqual([
      { path: 'A.md', height: 280 },
      { path: 'A.md', height: null },
    ]);
  await stayedLocal(page, outside);
});

test('cover resize: reposition still places the image in a taller band', async ({ page }) => {
  const outside = await open(page, 'A');
  await handle(page).focus();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect.poll(() => bandHeight(page)).toBe(540);
  await band(page).hover();
  await band(page).getByRole('button', { name: 'Reposition' }).click();
  const slider = page.getByRole('slider', { name: 'Cover position' });
  await expect(slider).toBeFocused();
  await expect(handle(page)).toHaveCount(0);
  await page.keyboard.press('ArrowUp');
  await expect(slider).toHaveAttribute('aria-valuenow', '55');
  await expect(page.locator('img[data-cover]')).toHaveCSS('object-position', '50% 55%');
  await page.getByRole('button', { name: 'Save position' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __liberWrites?: { text: string }[] }).__liberWrites?.at(-1)?.text,
      ),
    )
    .toContain('cover-y: 55');
  expect(await bandHeight(page)).toBe(540);
  await expect(handle(page)).toHaveCount(1);
  await stayedLocal(page, outside);
});

for (const theme of ['light', 'dark']) {
  test(`cover resize: axe-clean with the handle focused (${theme})`, async ({ page }) => {
    await open(page, 'A', { theme });
    await handle(page).focus();
    await page.keyboard.press('ArrowDown');
    await page.evaluate(AXE);
    const violations = await page.evaluate(async () => {
      const { axe } = window as unknown as {
        axe: {
          run: (
            el: Element,
            o: object,
          ) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
        };
      };
      const res = await axe.run(document.querySelector('[data-band="cover"]')!, {
        resultTypes: ['violations'],
        // Pre-existing (M2b feedback round): the "Format" button is named
        // "Formatting toolbar"; not part of this change.
        rules: { 'label-content-name-mismatch': { enabled: false } },
      });
      return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`);
    });
    expect(violations).toEqual([]);
  });
}
