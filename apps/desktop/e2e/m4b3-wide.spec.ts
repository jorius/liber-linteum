// M4b part 3, wide elements, in the built UI in Chromium and WebKit
// (≈ WKWebView): a table keeps its words whole; on a "Wide elements" page it
// escapes the readable measure while the text keeps it; Full is unchanged.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

// Jose's "Military Ranks" table (seven columns), squeezed into the measure.
const RANKS = [
  '| Category | Rank | Stars | Typical Color | Conceptual Insignia | Command Role | Authorized Ship Classes |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  '| Pre-Commissioned | Cadet | — | Bronze | No insignia / trainee bar | Trainee — no independent command | None (training only) |',
  '| Junior Officers | Second Lieutenant | — | Gold | No stars / single bar | Junior officer, basic tactical command | Scout |',
  '| Junior Officers | First Lieutenant | — | Gold | Double bar | Patrol command | Scout, Interceptor |',
  '| Field Officers | Major | ★ | Gold | 1 star | Advanced squad leader | Striker, Freighter |',
].join('\n');

const LONG = 'Incomprehensibilities';
const PAGES: Record<string, string> = {
  'Ranks.md':
    '# Military Ranks\n\nThe Supreme Admiralty stands above conventional military hierarchy. ' +
    'Admirals in this category exercise total control over interstellar fleets.\n\n' +
    `${RANKS}\n\nAfter the table.\n`,
  'Long.md': `# Long\n\nIntro.\n\n| ${Array(6).fill('A').join(' | ')} |\n| ${Array(6).fill('---').join(' | ')} |\n| ${Array(6).fill(LONG).join(' | ')} |\n\nEnd.\n`,
  'Code.md':
    '# Code\n\nIntro paragraph.\n\n```js\nconst ranks = [' +
    Array.from({ length: 12 }, (_, i) => `'rank${i}'`).join(', ') +
    '];\n```\n\nAfter.\n',
};

async function open(page: Page, name: string, settings: Record<string, unknown> = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages: { ...PAGES },
    editorMode: 'livePreview',
    settings,
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue(name);
  if (name !== 'Code') await expect(page.locator('.cm-nimw-widget table')).toBeVisible();
  return errors;
}

/** Words (split at spaces, hyphens and slashes, where a line may break)
 *  that a table cell shows across more than one line. */
const brokenWords = (page: Page) =>
  page.evaluate(() => {
    const broken: string[] = [];
    for (const cell of document.querySelectorAll('.cm-nimw-widget td, .cm-nimw-widget th')) {
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = (n as Text).data;
        const word = /[^\s\-/—]+/g;
        for (let m = word.exec(text); m; m = word.exec(text)) {
          const r = document.createRange();
          r.setStart(n, m.index);
          r.setEnd(n, m.index + m[0].length);
          const tops = new Set(
            [...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top)),
          );
          if (tops.size > 1) broken.push(m[0]);
        }
      }
    }
    return broken;
  });

/** The table widget's box against the text column's. */
const geometry = (page: Page) =>
  page.evaluate(() => {
    const content = document.querySelector<HTMLElement>('.cm-content')!;
    const style = getComputedStyle(content);
    const c = content.getBoundingClientRect();
    const box = {
      left: c.left + parseFloat(style.paddingLeft),
      right: c.right - parseFloat(style.paddingRight),
    };
    // The rendered table's box: the widget's content (the widget itself is
    // the frame it is placed in).
    const w = document.querySelector('.cm-nimw-widget > *')!.getBoundingClientRect();
    const scroller = document.querySelector('.cm-scroller')!.getBoundingClientRect();
    const gutter = document.querySelector('.cm-gutters')?.getBoundingClientRect() ?? null;
    const para = [...document.querySelectorAll<HTMLElement>('.cm-line')]
      .find((l) => l.textContent?.startsWith('The Supreme'))
      ?.getBoundingClientRect();
    return {
      text: box.right - box.left,
      textCentre: (box.left + box.right) / 2,
      widget: w.width,
      widgetLeft: w.left,
      widgetRight: w.right,
      widgetCentre: (w.left + w.right) / 2,
      scrollerLeft: scroller.left,
      scrollerRight: scroller.right,
      gutterRight: gutter ? gutter.right : null,
      para: para ? para.width : 0,
      measure: content.clientWidth,
    };
  });

async function chooseWidth(page: Page, name: 'Readable' | 'Wide elements' | 'Full width') {
  await page.getByRole('button', { name: 'Page width' }).click();
  await page.getByRole('menuitemradio', { name }).click();
}

test.use({ viewport: { width: 1280, height: 900 } });

test('Readable: table cells keep their words whole', async ({ page }) => {
  const errors = await open(page, 'Ranks');
  await expect(page.locator('[data-width]')).toHaveAttribute('data-width', 'readable');
  expect(await brokenWords(page)).toEqual([]);
  const g = await geometry(page);
  expect(g.widget).toBeLessThanOrEqual(g.text + 1);
  expect(errors).toEqual([]);
});

test('Readable: a table that cannot fit scrolls sideways in a focusable box', async ({ page }) => {
  await open(page, 'Long');
  const region = page.getByRole('region', { name: 'Table, scrolls sideways' });
  await expect(region).toBeVisible();
  await expect(region).toHaveAttribute('tabindex', '0');
  expect(await brokenWords(page)).toEqual([]);
  const scrolls = await region.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(scrolls).toBe(true);
});

test('Wide elements: the table spans the editor while the text keeps the measure', async ({
  page,
}) => {
  const errors = await open(page, 'Ranks');
  await chooseWidth(page, 'Wide elements');
  await expect(page.locator('[data-width]')).toHaveAttribute('data-width', 'wide');
  await expect(page.locator('[data-width]')).toHaveAttribute('data-wide-tables', '');
  await expect.poll(async () => (await geometry(page)).widget).toBeGreaterThan(800);
  const g = await geometry(page);
  expect(g.measure).toBeLessThanOrEqual(760);
  expect(g.para).toBeLessThanOrEqual(g.text + 1);
  expect(Math.abs(g.widgetCentre - g.textCentre)).toBeLessThan(2);
  expect(g.widgetLeft).toBeGreaterThanOrEqual(g.scrollerLeft);
  expect(g.widgetRight).toBeLessThanOrEqual(g.scrollerRight);
  expect(await brokenWords(page)).toEqual([]);
  // Clicking into the table shows its source in the same wide box; typing works.
  await page.locator('.cm-nimw-widget td').first().click();
  const raw = page.locator('.cm-line[data-wide-src="tables"]').first();
  await expect(raw).toBeVisible();
  expect(await raw.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(g.text + 50);
  await page.keyboard.type('Z');
  await expect(page.locator('.cm-content')).toContainText('Z| Category');
  expect(errors).toEqual([]);
});

test('Wide elements: Tables unticked in Settings brings the table back to the measure', async ({
  page,
}) => {
  await open(page, 'Ranks', { pageWidth: 'wide' });
  await expect.poll(async () => (await geometry(page)).widget).toBeGreaterThan(800);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page
    .getByRole('group', { name: 'Wide elements' })
    .getByRole('checkbox', { name: 'Tables' })
    .uncheck();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-width]')).not.toHaveAttribute('data-wide-tables', '');
  const g = await geometry(page);
  expect(g.widget).toBeLessThanOrEqual(g.text + 1);
  expect(await brokenWords(page)).toEqual([]);
});

test('Wide elements with line numbers: the table stays clear of the gutter', async ({ page }) => {
  await open(page, 'Ranks', { pageWidth: 'wide', lineNumbers: true });
  // The gutter sits beside the measure, so the table keeps the text's left
  // edge and grows to the right, up to the editor's edge.
  await expect
    .poll(async () => {
      const g = await geometry(page);
      return g.widget - g.text;
    })
    .toBeGreaterThan(50);
  const g = await geometry(page);
  expect(g.gutterRight).not.toBeNull();
  expect(g.widgetLeft).toBeGreaterThanOrEqual(g.gutterRight!);
  expect(Math.abs(g.widgetLeft - (g.textCentre - g.text / 2))).toBeLessThan(2);
  expect(g.widgetRight).toBeLessThanOrEqual(g.scrollerRight);
});

test('Wide elements with Code blocks: long code lines widen, and the caret lands where clicked', async ({
  page,
}) => {
  await open(page, 'Code', {
    pageWidth: 'wide',
    wideElements: { tables: true, code: true, diagrams: true, images: false, maths: false },
  });
  const long = page.locator('.cm-line[data-wide-src="code"]', { hasText: 'const ranks' });
  const box = async () =>
    page.evaluate(() => {
      const line = [...document.querySelectorAll<HTMLElement>('.cm-line[data-wide-src="code"]')]
        .find((l) => l.textContent?.startsWith('const ranks'))!
        .getBoundingClientRect();
      const para = [...document.querySelectorAll<HTMLElement>('.cm-line')]
        .find((l) => l.textContent === 'Intro paragraph.')!
        .getBoundingClientRect();
      return { line: line.width, lineLeft: line.left, lineRight: line.right, para: para.width };
    });
  await expect.poll(async () => (await box()).line - (await box()).para).toBeGreaterThan(50);
  const b = await box();
  // A click at its end puts the caret there.
  await page.mouse.click(b.lineRight - 4, (await long.boundingBox())!.y + 6);
  await page.keyboard.press('End');
  await page.keyboard.type('// ok');
  await expect(long).toContainText("'rank11'];// ok");
});

test('Full width is unchanged: the text spans the editor', async ({ page }) => {
  await open(page, 'Ranks');
  await chooseWidth(page, 'Full width');
  await expect(page.locator('[data-width]')).toHaveAttribute('data-width', 'full');
  const g = await geometry(page);
  expect(g.measure).toBeGreaterThan(760);
  expect(g.widget).toBeLessThanOrEqual(g.text + 1);
});

for (const theme of ['light', 'dark']) {
  test(`the width menu and its button have no axe violations (${theme})`, async ({ page }) => {
    await open(page, 'Ranks', { theme });
    await page.getByRole('button', { name: 'Page width' }).click();
    await expect(page.getByRole('menu', { name: 'Page width' })).toBeVisible();
    await page.evaluate(AXE);
    const violations = await page.evaluate(async () => {
      const { axe } = window as unknown as {
        axe: {
          run: (
            el: { include: string[][] },
            o: object,
          ) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
        };
      };
      const res = await axe.run(
        { include: [['[role="menu"]'], ['button[aria-label="Page width"]']] },
        { resultTypes: ['violations'] },
      );
      return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`);
    });
    expect(violations).toEqual([]);
  });
}
