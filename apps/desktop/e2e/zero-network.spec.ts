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
