// NFR-04 / arch §6.1 layer 3 (M2a §7): the built UI, under the production CSP
// and Tauri's frozen prototypes, renders a page full of remote references in
// every editor mode without a single non-local request — and without the CSP
// having to block anything (the sanitizer already removed every reference;
// the CSP is the second layer, so a violation here is a sanitizer bug).
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { installIpcMock } from './ipcMock';

const REMOTE = readFileSync(new URL('./remote.md', import.meta.url), 'utf8');
const PAGES = {
  'remote.md': REMOTE,
  'Other.md': '# Other\n\n## Section\n\n![nested](https://remote.example/v.png)\n',
};

/** Records every request that isn't to the local test server, and stops it. */
async function watchNetwork(page: Page) {
  const outside: string[] = [];
  const problems: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    const local = url.protocol === 'http:' && url.hostname === '127.0.0.1';
    if (!local && url.protocol !== 'data:') outside.push(r.url());
  });
  page.on('pageerror', (e) => problems.push(`error: ${e.message}`));
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, (route) => route.abort());
  return { outside, problems };
}

/** Scrolls `selector` through its whole height (CodeMirror and lazy embeds
 *  render only what is in view). */
async function scrollThrough(page: Page, selector: string) {
  const el = page.locator(selector).first();
  for (let i = 0; i < 40; i++) {
    const done = await el.evaluate((e) => {
      e.scrollTop += e.clientHeight * 0.8;
      return e.scrollTop + e.clientHeight >= e.scrollHeight - 1;
    });
    await page.waitForTimeout(60);
    if (done) break;
  }
}

async function openRemotePage(page: Page, mode: string, settings: Record<string, unknown> = {}) {
  const seen = await watchNetwork(page);
  await page.addInitScript(installIpcMock, { pages: PAGES, editorMode: mode, settings });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name: 'remote' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'remote', exact: true })).toBeVisible();
  return seen;
}

test('the interceptor records a request that tries to leave', async ({ page }) => {
  const { outside } = await watchNetwork(page);
  await page.goto('/');
  await page.evaluate(() => {
    const a = document.createElement('a');
    a.href = 'https://remote.example/probe';
    a.click();
  });
  await expect.poll(() => outside).toEqual(['https://remote.example/probe']);
});

for (const mode of ['livePreview', 'source', 'split']) {
  test(`zero network requests: ${mode}`, async ({ page }) => {
    const { outside, problems } = await openRemotePage(page, mode);
    if (mode === 'split') {
      const pane = page.getByRole('region', { name: 'Preview' });
      await expect(pane.getByText('Remote image blocked (privacy)').first()).toBeVisible();
      await scrollThrough(page, '[role="region"][aria-label="Preview"]');
      await expect(pane.getByRole('region', { name: 'Other › Section' })).toBeVisible();
    }
    if (mode === 'livePreview') {
      await expect(page.locator('.cm-nimw-widget').first()).toBeVisible();
    }
    await scrollThrough(page, '.cm-scroller');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500); // debounced renders, lazy embeds
    const csp = await page.evaluate(
      () => (window as unknown as { __nimwCspViolations: string[] }).__nimwCspViolations,
    );
    expect(problems).toEqual([]);
    expect(csp).toEqual([]); // nothing even reached the CSP
    expect(outside).toEqual([]);
  });
}

// M2b: every palette (and a custom accent) with installed fonts picked by
// name: still nothing leaves the machine, and the palette really applies.
for (const palette of [
  'lavender',
  'graphite',
  'rosewood',
  'saffron',
  'persimmon',
  'midnight',
  'sepia',
  'ink',
  'custom',
]) {
  test(`zero network requests: ${palette} palette with installed fonts`, async ({ page }) => {
    const { outside, problems } = await openRemotePage(page, 'split', {
      palette,
      accentColor: '#2aa198',
      fontLivePreview: 'system:Menlo',
      fontSource: 'system:Courier New',
    });
    await expect(page.locator('html')).toHaveAttribute('data-palette', palette);
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--font-live'),
        ),
      )
      .toContain('"Menlo"');
    await scrollThrough(page, '[role="region"][aria-label="Preview"]');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(300);
    const csp = await page.evaluate(
      () => (window as unknown as { __nimwCspViolations: string[] }).__nimwCspViolations,
    );
    expect(problems).toEqual([]);
    expect(csp).toEqual([]);
    expect(outside).toEqual([]);
  });
}

// M3a §1: the Global View — cards with remote covers, edges, a page's
// neighbourhood and Expand — loads nothing from outside either.
test('zero network requests: the Global View', async ({ page }) => {
  const { outside, problems } = await openRemotePage(page, 'livePreview');
  await page.getByRole('button', { name: 'Global view' }).click();
  const remote = page.getByRole('button', { name: 'Remote references', exact: true });
  await expect(remote).toBeVisible();
  const gv = page.getByRole('region', { name: 'Global View' });
  await expect(gv.getByText('Remote cover not loaded', { exact: true }).first()).toBeVisible();
  await remote.click();
  await expect(page.getByRole('navigation', { name: 'Global View path' })).toContainText(
    'Remote references',
  );
  await page.getByRole('button', { name: 'Expand in place' }).click();
  await expect(page.getByRole('button', { name: 'Expand in place' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  const csp = await page.evaluate(
    () => (window as unknown as { __nimwCspViolations: string[] }).__nimwCspViolations,
  );
  expect(problems).toEqual([]);
  expect(csp).toEqual([]);
  expect(outside).toEqual([]);
});

// M3b: connecting cards, the relationships dialog and an index-note pick
// load nothing from outside either.
test('zero network requests: relationships in the Global View', async ({ page }) => {
  const { outside, problems } = await openRemotePage(page, 'livePreview');
  await page.getByRole('button', { name: 'Global view' }).click();
  await page.getByRole('button', { name: 'Connections of Other' }).click();
  await page.getByRole('menuitem', { name: 'Connect to…' }).click();
  await page.getByRole('button', { name: 'Remote references', exact: true }).click();
  await expect(page.locator('[data-gv-edge="manual"]')).toHaveCount(1);
  await page.locator('[data-gv-hit]').click({ force: true });
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  const csp = await page.evaluate(
    () => (window as unknown as { __nimwCspViolations: string[] }).__nimwCspViolations,
  );
  expect(problems).toEqual([]);
  expect(csp).toEqual([]);
  expect(outside).toEqual([]);
});

// M4: moving blocks in the Split pane loads nothing from outside either.
test('zero network requests: moving blocks in Split', async ({ page }) => {
  const { outside, problems } = await openRemotePage(page, 'split');
  const pane = page.getByRole('region', { name: 'Preview' });
  await expect(pane.locator('[data-source-start]').first()).toBeVisible();
  const first = page.getByRole('button', { name: /^Drag to reorder:/ }).first();
  await first.focus();
  await page.keyboard.press('Alt+ArrowDown');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  const csp = await page.evaluate(
    () => (window as unknown as { __nimwCspViolations: string[] }).__nimwCspViolations,
  );
  expect(problems).toEqual([]);
  expect(csp).toEqual([]);
  expect(outside).toEqual([]);
});

// M4b part 2 §3, §4: maths and a Mermaid diagram, in Split and Live Preview
// (a page of their own: the Global View tests above count the cards).
const RICH = {
  ...PAGES,
  'Rich.md':
    '# Rich\n\nInline $E = mc^2$ and ![x](https://remote.example/m.png).\n\n$$\n\\sum_{i=1}^n i\n$$\n\n' +
    '```mermaid\nflowchart LR\n  A[Start] --> B[End]\n  click A href "https://remote.example/diagram"\n```\n',
};

for (const mode of ['split', 'livePreview']) {
  test(`zero network requests: maths and Mermaid (${mode})`, async ({ page }) => {
    const seen = await watchNetwork(page);
    await page.addInitScript(installIpcMock, { pages: RICH, editorMode: mode });
    await page.goto('/');
    await page.getByRole('button', { name: /^vault/ }).click();
    await page.getByRole('treeitem', { name: 'Rich' }).click();
    const where =
      mode === 'split'
        ? page.getByRole('region', { name: 'Preview' })
        : page.locator('.cm-content');
    await expect(where.locator('.katex').first()).toBeVisible();
    const diagram = where.getByRole('img', { name: 'Diagram: flowchart LR' }).locator('svg');
    await expect(diagram).toBeVisible({
      timeout: 15_000,
    });
    // Its link is inert (final review I5): a click goes nowhere.
    const app = page.url();
    await diagram.getByText('Start', { exact: true }).click();
    await expect(page.getByRole('treeitem', { name: 'Rich' })).toBeVisible();
    expect(page.url()).toBe(app);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState('networkidle');
    const csp = await page.evaluate(
      () => (window as unknown as { __nimwCspViolations: string[] }).__nimwCspViolations,
    );
    expect(seen.problems).toEqual([]);
    expect(csp).toEqual([]);
    expect(seen.outside).toEqual([]);
  });
}
