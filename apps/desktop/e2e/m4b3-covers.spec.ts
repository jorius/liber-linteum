// M4b part 3 §1–§3 in the built UI, in Chromium (≈ WebView2 on Windows) and
// WebKit (≈ WKWebView): side covers (a tall strip on the left or right,
// resized and kept per page across a reload, repositioned in both axes,
// shown on top when the window is too narrow), covers that crop where they
// were placed in both engines, and titles that follow a first-line H1 only.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

const PAGES = {
  'A.md': '---\ncover: sky.png\n---\n# Alpha\n\nhello world\n\n## One\n\n## Two\n',
  'Focus.md': '---\ncover: sky.png\ncover-y: 100\ncover-x: 0\n---\n# Focus\n\ntext\n',
  'Tipos de comisiones.md':
    'Los tipos de comisiones que quiero hacer.\n\nNo hago gore\n# WIP (Work In Progress):\nSon avances.\n',
};

/** A Windows WebView2 user agent: vault files go through
 *  http://liber-asset.localhost, which the test can serve. */
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';

/** A tall image (400 × 1200): red on top, blue below. */
const TALL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="1200">' +
  '<rect width="400" height="600" fill="#d00"/><rect y="600" width="400" height="600" fill="#00d"/></svg>';

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
  // Vault files over WebView2's http form (only reached with WINDOWS_UA).
  await page.route(/^http:\/\/liber-asset\.localhost\//, (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: TALL_SVG }),
  );
  return outside;
}

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

async function stayedLocal(page: Page, outside: string[]) {
  await page.waitForLoadState('networkidle');
  expect(outside).toEqual([]);
  expect(
    await page.evaluate(
      () => (window as unknown as { __liberCspViolations: string[] }).__liberCspViolations,
    ),
  ).toEqual([]);
}

const strip = (page: Page) => page.locator('[data-cover-strip]');
const region = (page: Page) => page.getByRole('region', { name: 'Page', exact: true });
const edge = (page: Page) => page.getByRole('separator', { name: 'Cover width' });
const radio = (page: Page, name: string) =>
  page.getByRole('radiogroup', { name: 'Cover placement' }).getByRole('radio', { name });
const stripWidth = (page: Page) => strip(page).evaluate((el) => el.getBoundingClientRect().width);
const sides = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __liberCoverSides?: unknown[] }).__liberCoverSides ?? [],
  );

test.use({ viewport: { width: 1280, height: 900 } });

test('§3 side covers: Left makes a full-height strip beside the header and text; its edge resizes it; both are kept across a reload', async ({
  page,
}) => {
  const outside = await open(page, 'A');
  const band = page.locator('[data-band="cover"]');
  await band.hover();
  await radio(page, 'Cover on the left').click();
  await expect(strip(page)).toHaveAttribute('data-cover-strip', 'left');
  await expect.poll(() => sides(page)).toEqual([{ path: 'A.md', side: 'left' }]);
  await expect(page.locator('[data-band="plain"]')).toBeVisible();
  // The strip runs the page area's full height, at its left; the header
  // band and the text sit to its right.
  const area = (await region(page).boundingBox())!;
  const s = (await strip(page).boundingBox())!;
  expect(Math.abs(s.x - area.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(s.y - area.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(s.y + s.height - (area.y + area.height))).toBeLessThanOrEqual(1);
  expect(Math.round(s.width)).toBe(280);
  const header = (await page.locator('[data-band="plain"]').boundingBox())!;
  const text = (await page.locator('.cm-content').boundingBox())!;
  expect(header.x).toBeGreaterThanOrEqual(s.x + s.width - 1);
  expect(text.x).toBeGreaterThanOrEqual(s.x + s.width - 1);
  // Drag the inner edge 60 px right: 340 px, saved on release.
  await strip(page).hover();
  const h = (await edge(page).boundingBox())!;
  expect(Math.abs(h.x + h.width - (s.x + s.width))).toBeLessThanOrEqual(2);
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 60, h.y + h.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => stripWidth(page)).toBe(340);
  // The note itself is never written.
  expect(
    await page.evaluate(() => (window as unknown as { __liberWrites?: unknown[] }).__liberWrites),
  ).toBeUndefined();
  await page.reload();
  await openPage(page, 'A');
  await expect(strip(page)).toHaveAttribute('data-cover-strip', 'left');
  await expect.poll(() => stripWidth(page)).toBe(340);
  await stayedLocal(page, outside);
});

test('§3 side covers: a right strip is outermost, right of the outline panel', async ({ page }) => {
  const outside = await open(page, 'A', { outline: true });
  await page.locator('[data-band="cover"]').hover();
  await radio(page, 'Cover on the right').click();
  await expect(strip(page)).toHaveAttribute('data-cover-strip', 'right');
  const area = (await region(page).boundingBox())!;
  const s = (await strip(page).boundingBox())!;
  const outline = (await page.getByRole('tree', { name: 'Outline' }).boundingBox())!;
  expect(Math.abs(s.x + s.width - (area.x + area.width))).toBeLessThanOrEqual(1);
  expect(outline.x + outline.width).toBeLessThanOrEqual(s.x + 1);
  await stayedLocal(page, outside);
});

test('§3 side covers: reposition moves the focus in both axes; Save writes cover-x and cover-y', async ({
  page,
}) => {
  const outside = await open(page, 'A');
  await page.locator('[data-band="cover"]').hover();
  await radio(page, 'Cover on the left').click();
  await strip(page).hover();
  await strip(page).getByRole('button', { name: 'Reposition' }).click();
  const slider = page.getByRole('slider', { name: 'Cover position' });
  await expect(slider).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  await expect(slider).toHaveAttribute('aria-valuetext', '45% from the left, 55% from the top');
  await expect(page.locator('img[data-cover]')).toHaveCSS('object-position', '45% 55%');
  await strip(page).getByRole('button', { name: 'Save position' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __liberWrites?: { text: string }[] }).__liberWrites?.at(-1)?.text,
      ),
    )
    .toMatch(/cover-y: 55\ncover-x: 45\n/);
  await expect(strip(page).getByRole('button', { name: 'Reposition' })).toBeFocused();
  await stayedLocal(page, outside);
});

test('§3 side covers: a window too narrow for the strip shows the cover on top, and widening brings the strip back', async ({
  page,
}) => {
  const outside = await open(page, 'A');
  await page.locator('[data-band="cover"]').hover();
  await radio(page, 'Cover on the left').click();
  await expect(strip(page)).toBeVisible();
  await page.setViewportSize({ width: 860, height: 900 });
  await expect(strip(page)).toHaveCount(0);
  await expect(page.locator('[data-band="cover"]')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(strip(page)).toBeVisible();
  expect(await sides(page)).toHaveLength(1);
  await stayedLocal(page, outside);
});

test.describe('§2 covers crop where they were placed (WebView2 path)', () => {
  test.use({ userAgent: WINDOWS_UA });

  /** The image fills its frame exactly, so object-position does the crop. */
  async function fillsFrame(page: Page) {
    const img = page.locator('img[data-cover]');
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(400);
    const [box, frame] = await img.evaluate((el) => {
      const r = (e: Element) => {
        const b = e.getBoundingClientRect();
        return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
      };
      return [r(el), r(el.parentElement!)];
    });
    expect(box).toEqual(frame);
    expect(frame[2]).toBeGreaterThan(0);
    expect(frame[3]).toBeGreaterThan(0);
  }

  test('the header band and the side strip both fill their frame and follow cover-x / cover-y', async ({
    page,
  }) => {
    const outside = await open(page, 'Focus');
    await expect(page.locator('img[data-cover]')).toHaveAttribute(
      'src',
      'http://liber-asset.localhost/sky.png',
    );
    await fillsFrame(page);
    await expect(page.locator('img[data-cover]')).toHaveCSS('object-position', '0% 100%');
    await page.locator('[data-band="cover"]').hover();
    await radio(page, 'Cover on the right').click();
    await expect(strip(page)).toBeVisible();
    await fillsFrame(page);
    await expect(page.locator('img[data-cover]')).toHaveCSS('object-position', '0% 100%');
    await stayedLocal(page, outside);
  });
});

test('§1 titles: a heading halfway down is not the title; the file name is', async ({ page }) => {
  const outside = await open(page, 'Tipos de comisiones');
  // No "Title in the note" label: the note has no first-line H1.
  await expect(page.getByText(/Title in the note/)).toHaveCount(0);
  await stayedLocal(page, outside);
});

for (const theme of ['light', 'dark']) {
  test(`§3 side covers: axe-clean with the strip and its controls shown (${theme})`, async ({
    page,
  }) => {
    await open(page, 'A', { theme });
    await page.locator('[data-band="cover"]').hover();
    await radio(page, 'Cover on the left').click();
    await edge(page).focus();
    // The controls fully shown over the image (no fade in progress).
    await strip(page).hover();
    await expect
      .poll(() =>
        strip(page)
          .getByRole('button', { name: 'Remove' })
          .evaluate((el) => getComputedStyle(el.parentElement!).opacity),
      )
      .toBe('1');
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
      // The strip and the header band beside it (the editor has its own
      // axe checks).
      const out: string[] = [];
      for (const selector of ['[data-cover-strip]', '[data-band]']) {
        const res = await axe.run(document.querySelector(selector)!, {
          resultTypes: ['violations'],
          // Pre-existing (M2b feedback round): the "Format" button is named
          // "Formatting toolbar"; not part of this change.
          rules: { 'label-content-name-mismatch': { enabled: false } },
        });
        out.push(
          ...res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`),
        );
      }
      return out;
    });
    expect(violations).toEqual([]);
  });
}
