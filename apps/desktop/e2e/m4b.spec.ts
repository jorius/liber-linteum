// M4b in the built UI, in Chromium and WebKit (≈ WKWebView): the feedback
// round — a compact header band with the cover as its background, the page
// title in the top bar, and the pickers and chips that came with it — all
// without a single request leaving the machine. (Add cover going straight
// into reposition is checked in m2c.spec.ts.)
import { expect, test, type Page } from '@playwright/test';
import { showGlobalView } from './shell';
import { installIpcMock } from './ipcMock';

const LONG = Array.from({ length: 120 }, (_, i) => `Line ${i + 1} of the long page.`).join('\n\n');
const SUBTITLE =
  'A subtitle that runs on well past the room the page has for it, and then on, and on again past the measure of the text, which is wide';
const PAGES = {
  'A.md': '# Alpha\n\nhello world\n\nSee [[B]].\n',
  'B.md': '# Beta\n\nThe second page.\n',
  'Long.md': `# Long\n\n${LONG}\n`,
  [`${'A very long page name '.repeat(6).trim()}.md`]: '# Wordy\n\nText.\n',
  'Sub.md': `---\nsubtitle: ${SUBTITLE}\n---\n# Sub\n\nText.\n`,
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

async function open(
  page: Page,
  name: string,
  opts: { remoteCover?: boolean; settings?: Record<string, unknown> } = {},
) {
  const outside = await watchNetwork(page);
  await page.addInitScript(installIpcMock, {
    pages: { ...PAGES },
    editorMode: 'livePreview',
    remoteCover: opts.remoteCover ?? false,
    settings: opts.settings,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue(name);
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

const lastWrite = (page: Page, path?: string) =>
  page.evaluate((path) => {
    const writes =
      (window as unknown as { __liberWrites?: { path: string; text: string }[] }).__liberWrites ??
      [];
    return writes.filter((w) => !path || w.path === path).at(-1)?.text ?? null;
  }, path);

test.use({ viewport: { width: 1280, height: 900 } });

test('M4b §1: with a cover, the text starts in the top 35% of the window', async ({ page }) => {
  // Pages without a `cover:` get a (blocked) remote one: the band shows at full height.
  const outside = await open(page, 'A', { remoteCover: true });
  await expect(page.locator('[data-band="cover"]')).toBeVisible();
  const top = await page.locator('.cm-content').evaluate((el) => el.getBoundingClientRect().top);
  expect(top / 900).toBeLessThan(0.35);
  // The title is in the page (M5b §2.3); the floating button is on screen.
  const bar = page.getByRole('region', { name: 'Page' });
  await expect(bar.getByRole('textbox', { name: 'Page title' })).toHaveValue('A');
  await expect(page.getByRole('button', { name: 'Actions', exact: true })).toBeVisible();
  await stayedLocal(page, outside);
});

// Cover resize: the band is as tall as the default cover height (Medium,
// 200 px, unless set otherwise); the smallest choice is the M4b band.
for (const px of [200, 132]) {
  test(`final review M9: with a cover the band stays ${px} px from 900 to 1440 px wide`, async ({
    page,
  }) => {
    const wordy = 'A very long page name '.repeat(6).trim();
    const settings = px === 200 ? {} : { coverHeight: px };
    const outside = await open(page, wordy, { remoteCover: true, settings });
    const band = page.locator('[data-band="cover"]');
    for (const width of [900, 1100, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(band).toBeVisible();
      // The cover's controls show on hover and focus, over the band (not a row of their own).
      await band.hover();
      await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible();
      const height = await band.evaluate((el) => el.clientHeight); // without its border
      if (px === 200) expect(`${width}: ${height}`).toBe(`${width}: ${px}`);
      // The smallest choice can't hold the title, breadcrumb and facts rows
      // (Jose, M5b: the title heads the band): it grows just enough.
      else expect(height).toBeGreaterThanOrEqual(px);
      const foot = (await page.getByText(/links? · \d+ backlinks?/).boundingBox())!;
      const box = (await band.boundingBox())!;
      expect(foot.y + foot.height).toBeLessThanOrEqual(box.y + box.height);
      // Nothing overflows the window sideways.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    }
    await stayedLocal(page, outside);
  });
}

test('final review M9: a subtitle too long for the page ends in an ellipsis, whole on hover', async ({
  page,
}) => {
  const outside = await open(page, 'Sub');
  await page.setViewportSize({ width: 900, height: 900 });
  const subtitle = page
    .getByRole('region', { name: 'Page' })
    .getByRole('textbox', { name: 'Subtitle' });
  await expect(subtitle).toHaveValue(SUBTITLE);
  await expect(subtitle).toHaveAttribute('title', SUBTITLE);
  const cut = await subtitle.evaluate((el) => ({
    overflow: getComputedStyle(el).textOverflow,
    clipped: el.scrollWidth > el.clientWidth,
  }));
  expect(cut).toEqual({ overflow: 'ellipsis', clipped: true });
  await stayedLocal(page, outside);
});

test('M5b §2.3: the title and subtitle are edited in the page', async ({ page }) => {
  const outside = await open(page, 'B');
  const bar = page.getByRole('region', { name: 'Page' });
  const title = bar.getByRole('textbox', { name: 'Page title' });
  await title.fill('Beta notes');
  await title.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __liberRenames?: unknown[] }).__liberRenames),
    )
    .toEqual([{ from: 'B.md', to: 'Beta notes.md' }]);
  await expect(title).toHaveValue('Beta notes');
  const subtitle = bar.getByRole('textbox', { name: 'Subtitle' });
  await subtitle.fill('Second thoughts');
  await page.waitForTimeout(100); // CodeMirror's interaction delay
  await subtitle.press('Enter');
  await expect
    .poll(() => lastWrite(page, 'Beta notes.md'))
    .toMatch(/^---\nsubtitle: Second thoughts\n---\n# Beta/);
  await stayedLocal(page, outside);
});

test('M4b §4: the ⌘K picker follows the text as it scrolls, and stays in the window', async ({
  page,
}) => {
  const outside = await open(page, 'Long');
  const line = page.locator('.cm-line', { hasText: 'Line 8 of the long page.' });
  await line.dblclick({ position: { x: 20, y: 5 } });
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByRole('combobox', { name: 'Link to…' });
  await expect(input).toBeFocused();
  const picker = input.locator('..');
  const box = async () => (await picker.boundingBox())!;
  /** Right under the selected line, or right above it when there's no room
   *  below (M4b §4). */
  const attached = async () => {
    const [p, l] = [await box(), (await line.boundingBox())!];
    return Math.abs(p.y - (l.y + l.height)) < 12 || Math.abs(p.y + p.height - l.y) < 12;
  };
  await expect.poll(attached).toBe(true);
  // The text scrolls up: the picker goes with it.
  const before = (await line.boundingBox())!.y;
  await page.mouse.move(1180, 700);
  await page.mouse.wheel(0, 200);
  await expect.poll(async () => (await line.boundingBox())!.y).toBeLessThan(before - 100);
  await expect.poll(attached).toBe(true);
  // Far away: it stays inside the window, open.
  // CodeMirror keeps the selected line drawn, now far above the window.
  await page.mouse.wheel(0, 6000);
  await expect.poll(async () => (await line.boundingBox())?.y ?? 0).toBeLessThan(-500);
  await expect
    .poll(async () => {
      const b = await box();
      return b.y >= 8 && b.y + b.height <= 900 - 8 + 0.5 && b.x >= 8;
    })
    .toBe(true);
  await expect(input).toBeFocused();
  await stayedLocal(page, outside);
});

test('M4b §6: a Related chip is added through the picker, opens its page, and is removed', async ({
  page,
}) => {
  const outside = await open(page, 'A');
  await page.getByRole('button', { name: 'Add a related page' }).click();
  const input = page.getByRole('combobox', { name: 'Related page' });
  await expect(input).toBeFocused();
  await input.fill('beta');
  await expect(page.getByRole('listbox', { name: 'Pages' }).getByRole('option')).toHaveCount(1);
  await input.press('Enter');
  await expect
    .poll(() => lastWrite(page, 'A.md'))
    .toBe('---\nrelated:\n  - "[[B]]"\n---\n# Alpha\n\nhello world\n\nSee [[B]].\n');
  const related = page.getByRole('list', { name: 'Related pages' });
  await related.getByRole('button', { name: 'B', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('B');
  await page.getByRole('button', { name: 'Back to A' }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('A');
  await related.getByRole('button', { name: 'Remove the relationship to B' }).click();
  await expect.poll(() => lastWrite(page, 'A.md')).not.toContain('[[B]]"');
  await expect(related.getByRole('listitem')).toHaveCount(0);
  await stayedLocal(page, outside);
});

test('M4b §6: Connect cards picks the card to connect from, then the other', async ({ page }) => {
  const outside = await open(page, 'A');
  await showGlobalView(page);
  const connect = page.getByRole('button', { name: 'Connect cards' });
  await connect.click();
  await expect(connect).toHaveAttribute('aria-pressed', 'true');
  const status = page.getByRole('status', { name: 'Connecting' });
  await expect(status).toContainText('Click the card to connect from');
  await page.getByRole('button', { name: 'Alpha', exact: true }).click();
  await expect(status).toContainText('Pick the card to connect: Alpha → ?');
  await page.getByRole('button', { name: 'Long', exact: true }).click();
  await expect.poll(() => lastWrite(page, 'A.md')).toContain('related:\n  - "[[Long]]"');
  await expect(page.locator('[data-gv-edge="manual"]')).toHaveCount(1);
  await expect(connect).toHaveAttribute('aria-pressed', 'false');
  await stayedLocal(page, outside);
});

for (const width of [1280, 900]) {
  test(`review focus: a very long title stays within the page at ${width} px; the floating button stays on screen`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const name = 'A very long page name '.repeat(6).trim();
    const outside = await open(page, name);
    const bar = page.getByRole('region', { name: 'Page' });
    const title = (await bar.getByRole('textbox', { name: 'Page title' }).boundingBox())!;
    const actions = (await page
      .getByRole('button', { name: 'Actions', exact: true })
      .boundingBox())!;
    expect(title.x + title.width).toBeLessThanOrEqual(width);
    expect(actions.x + actions.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await stayedLocal(page, outside);
  });
}
