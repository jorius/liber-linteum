// M4b part 3, Global View (spec §2–§6) in the built UI, in Chromium (≈
// WebView2, Windows) and WebKit (≈ WKWebView, macOS): card covers crop to
// their focus, side-cover strips, pages vs folders, readable edges, and
// See atoms.
import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

/** WebView2's user agent: the app reaches vault files over
 *  http://nimw-asset.localhost, which the test can serve. */
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0';

/** A `w` × `h` PNG in three horizontal bands: red, green, blue (top to
 *  bottom), so where a crop lands is visible. */
function bandsPng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const band = Math.min(2, Math.floor((y * 3) / h));
    for (let x = 0; x < w; x++) rows[y * (w * 3 + 1) + 1 + x * 3 + band] = 255;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TALL = bandsPng(120, 600);
const WIDE = bandsPng(600, 120);

async function serveImages(page: Page) {
  await page.route('http://nimw-asset.localhost/**', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: route.request().url().includes('wide') ? WIDE : TALL,
    }),
  );
}

async function globalView(
  page: Page,
  pages: Record<string, string>,
  opts: { files?: string[]; coverSides?: Record<string, 'left' | 'right'> } = {},
) {
  await page.addInitScript(installIpcMock, {
    pages: { ...pages },
    editorMode: 'livePreview',
    remoteCover: false,
    files: opts.files ?? [],
    coverSides: opts.coverSides ?? {},
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('button', { name: 'Global view' }).click();
  await expect(page.getByRole('region', { name: 'Global View' })).toBeVisible();
}

/** The card's cover image, once loaded. */
async function loadedCover(page: Page, path: string) {
  const img = page.locator(`.react-flow__node[data-id="${path}"] img`);
  await expect(img).toHaveCount(1);
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalHeight))
    .toBeGreaterThan(0);
  return img;
}

/** The image's rendered box against its frame (the element that clips it). */
const boxes = (img: ReturnType<Page['locator']>) =>
  img.evaluate((el: HTMLImageElement) => {
    const r = el.getBoundingClientRect();
    const f = el.parentElement!.getBoundingClientRect();
    return {
      img: { w: Math.round(r.width), h: Math.round(r.height) },
      frame: { w: Math.round(f.width), h: Math.round(f.height) },
      position: getComputedStyle(el).objectPosition,
    };
  });

test.describe('card covers (spec §2: WebView2 showed the top of the image)', () => {
  test.use({ userAgent: WINDOWS_UA });

  test('a cover fills its frame exactly, so its repositioned part shows', async ({ page }) => {
    await serveImages(page);
    await globalView(
      page,
      { 'A.md': '---\ncover: tall.png\ncover-y: 100\n---\n# Alpha\n\nBody.\n' },
      { files: ['tall.png'] },
    );
    const b = await boxes(await loadedCover(page, 'A.md'));
    // A natural-size image overflows its 96 px frame and object-position has
    // nothing to crop: the frame shows the image's top (the Windows report).
    expect(b.img).toEqual(b.frame);
    expect(b.frame.h).toBe(96);
    expect(b.position).toBe('50% 100%');
  });

  test('§3: a side cover is a full-height strip on its side, focus in both axes', async ({
    page,
  }) => {
    await serveImages(page);
    await globalView(
      page,
      {
        'L.md': '---\ncover: wide.png\ncover-x: 20\ncover-y: 70\n---\n# Left\n\nBody.\n',
        'R.md': '---\ncover: wide.png\n---\n# Right\n\nBody.\n',
      },
      { files: ['wide.png'], coverSides: { 'L.md': 'left', 'R.md': 'right' } },
    );
    const left = await loadedCover(page, 'L.md');
    const l = await boxes(left);
    expect(l.img).toEqual(l.frame);
    expect(l.frame.w).toBe(96);
    expect(l.position).toBe('20% 70%');
    const card = page.locator('.react-flow__node[data-id="L.md"]');
    const cardBox = (await card.boundingBox())!;
    const strip = (await left.boundingBox())!;
    expect(Math.round(strip.x - cardBox.x)).toBeLessThanOrEqual(1);
    // The title sits beside the strip, not under it.
    const title = (await card.getByText('Left', { exact: true }).boundingBox())!;
    expect(title.x).toBeGreaterThanOrEqual(strip.x + strip.width);

    const right = await loadedCover(page, 'R.md');
    const r = await boxes(right);
    expect(r.img).toEqual(r.frame);
    const rCard = (await page.locator('.react-flow__node[data-id="R.md"]').boundingBox())!;
    const rStrip = (await right.boundingBox())!;
    expect(Math.round(rCard.x + rCard.width - (rStrip.x + rStrip.width))).toBeLessThanOrEqual(1);
    expect(r.position).toBe('50% 50%');
  });
});
