// M4b part 3, Global View (spec §2–§6) in the built UI, in Chromium (≈
// WebView2, Windows) and WebKit (≈ WKWebView, macOS): card covers crop to
// their focus, side-cover strips, pages vs folders, readable edges, and
// See atoms.
import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { showGlobalView } from './shell';
import { installIpcMock } from './ipcMock';

/** WebView2's user agent: the app reaches vault files over
 *  http://liber-asset.localhost, which the test can serve. */
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
  await page.route('http://liber-asset.localhost/**', (route) =>
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
  await showGlobalView(page);
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

test('§4: page cards say Edit and open the editor; folders keep See all and look like folders', async ({
  page,
}) => {
  await globalView(page, {
    'Alpha/One.md': '# One\n\nFirst.\n',
    'Welcome.md': '# Welcome\n\nStart here.\n',
  });
  const folder = page.getByRole('group', { name: 'Alpha, project' });
  await expect(folder).toHaveAttribute('data-kind', 'project');
  await expect(folder.getByRole('button', { name: 'See all: Alpha' })).toBeVisible();
  // The tab sits on the folder card's top edge, above its box.
  const tab = page.locator('.react-flow__node[data-id="Alpha"] [data-gv-tab]');
  const tabBox = (await tab.boundingBox())!;
  const folderBox = (await folder.boundingBox())!;
  expect(tabBox.y).toBeLessThan(folderBox.y);
  await expect(page.locator('.react-flow__node[data-id="Welcome.md"] [data-gv-tab]')).toHaveCount(
    0,
  );

  const welcome = page.getByRole('group', { name: 'Welcome, page' });
  await expect(welcome.getByRole('button', { name: /^See all/ })).toHaveCount(0);
  await welcome.getByRole('button', { name: 'Edit Welcome' }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Welcome');
});

test('§5: parent/child lines are elbows, folder links carry a count chip, hover dims the rest', async ({
  page,
}) => {
  await page.addInitScript(installIpcMock, {
    pages: {
      'Alpha/One.md': '# One\n\nSee [[Three]] and [[Four]].\n',
      'Alpha/Two.md': '# Two\n\nSee [[Three]].\n',
      'Beta/Three.md': '# Three\n\nThe third.\n',
      'Beta/Four.md': '# Four\n\nThe fourth.\n',
      'Gamma/Five.md': '# Five\n\nAlone.\n',
    },
    editorMode: 'livePreview',
    remoteCover: false,
    settings: { globalViewMode: 'expand' },
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await showGlobalView(page);
  await page.getByRole('button', { name: 'Alpha', exact: true }).click();
  await expect(page.locator('[data-gv-edge="tree"]')).toHaveCount(2);
  for (const d of await page
    .locator('[data-gv-edge="tree"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('d')!))) {
    expect(d.replace(/[^MLHV]/g, '')).toBe('MHVH');
  }
  // One → Beta: two links into the folder, one chip.
  const chip = page.locator('[data-gv-count][data-a="Alpha/One.md"][data-b="Beta"]');
  await expect(chip).toHaveText('2 links');
  // The legend shows each kind's line.
  await expect(page.locator('[data-gv-sample="tree"] path')).toHaveAttribute(
    'd',
    'M3,1.5V6H27V10.5',
  );

  const canvas = page.locator('[data-gv-canvas]');
  // Expanding put the cards below the fold: bring them all in.
  await page.getByRole('button', { name: 'Fit to screen' }).click();
  await page.getByRole('button', { name: 'Gamma', exact: true }).hover();
  await expect(canvas).toHaveAttribute('data-gv-focusing', '');
  const opacity = (sel: string) =>
    page
      .locator(sel)
      .first()
      .evaluate((el) => getComputedStyle(el).opacity);
  expect(await opacity('[data-gv-edge="link-aggregated"]')).toBe('0.15');
  expect(await opacity('.react-flow__node[data-id="Alpha"]')).toBe('0.55');
  await page.getByRole('button', { name: 'Beta', exact: true }).hover();
  expect(await opacity('[data-gv-edge="link-aggregated"]')).toBe('1');
  expect(await opacity('.react-flow__node[data-id="Alpha/One.md"]')).toBe('1');
  expect(await opacity('.react-flow__node[data-id="Alpha"]')).toBe('0.55');
  expect(await opacity('[data-gv-edge="tree"]')).toBe('0.15');
  await page.mouse.move(2, 2);
  await expect(canvas).not.toHaveAttribute('data-gv-focusing');
});

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

const REX = [
  '# Rex',
  '',
  'Teen agent, see [[Sparda]].',
  '',
  '# Abilities',
  '',
  'Builds machines.',
  '',
  '```js',
  'const nanites = 7;',
  '```',
  '',
  '## Weak spots',
  '',
  '- water',
  '- magnets',
  '',
].join('\n');

async function atomsOfRex(page: Page, settings: Record<string, unknown> = {}) {
  await page.addInitScript(installIpcMock, {
    pages: { 'Rex.md': REX, 'Sparda.md': '# Sparda\n\nA legend.\n' },
    editorMode: 'livePreview',
    remoteCover: false,
    settings,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await showGlobalView(page);
  await page.getByRole('button', { name: 'See atoms of Rex' }).click();
  await expect(page.getByRole('application', { name: 'Atoms of Rex' })).toBeVisible();
}

test('§6: See atoms shows a page as sections and blocks; a block opens the editor there', async ({
  page,
}) => {
  await atomsOfRex(page);
  const map = page.getByRole('application', { name: 'Atoms of Rex' });
  await expect(map.getByRole('button', { name: 'Heading 1: Abilities' })).toBeVisible();
  await expect(map.getByRole('button', { name: 'Heading 2: Weak spots' })).toBeVisible();
  await expect(map.getByRole('button', { name: 'Code · js: const nanites = 7;' })).toBeVisible();
  await expect(map.getByRole('button', { name: 'List: water, magnets' })).toBeVisible();
  // The block linking Sparda points at Sparda's card.
  await expect(map.getByRole('button', { name: 'Sparda', exact: true })).toBeVisible();
  await expect(page.locator('[data-gv-edge="link"][data-b="Sparda.md"]')).toHaveCount(1);
  // Blocks hang off a trunk down their section's left side.
  const trunks = await page
    .locator('[data-gv-edge="tree"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('d')!.replace(/[^MLHV]/g, '')));
  expect(trunks).toContain('MVH');
  await expect(
    page.getByRole('navigation', { name: 'Global View path' }).getByText('Atoms'),
  ).toHaveAttribute('aria-current', 'page');

  await map.getByRole('button', { name: 'List: water, magnets' }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Rex');
  // The cursor is on the list, its lines flash.
  await expect(page.locator('.cm-liber-flash').first()).toContainText('water');
  const head = await page.evaluate(() => {
    const sel = window.getSelection();
    return sel?.anchorNode?.textContent ?? '';
  });
  expect(head).toContain('water');
});

test('§6: Escape goes back to the level with the keyboard on the page card', async ({ page }) => {
  await atomsOfRex(page);
  const map = page.getByRole('application', { name: 'Atoms of Rex' });
  await map.getByRole('button', { name: 'Heading 1: Abilities' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(map.getByRole('button', { name: 'Paragraph: Builds machines.' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Rex', exact: true })).toBeFocused();
  await expect(page.getByRole('application', { name: 'Atoms of Rex' })).toHaveCount(0);
});

for (const theme of ['light', 'dark']) {
  test(`§6: the atoms map is axe-clean in a real engine (${theme})`, async ({ page }) => {
    await atomsOfRex(page, { theme });
    await expect(page.getByRole('button', { name: 'Heading 2: Weak spots' })).toBeVisible();
    // The pointer off the cards: hovering one dims the others (§5, a
    // passing state the pointer asked for).
    await page.mouse.move(1, 1);
    await expect(page.locator('[data-gv-canvas]')).not.toHaveAttribute('data-gv-focusing');
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
      const region = document.querySelector('section[aria-label="Global View"]')!;
      const res = await axe.run(region, { resultTypes: ['violations'] });
      return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`);
    });
    expect(violations).toEqual([]);
  });
}
