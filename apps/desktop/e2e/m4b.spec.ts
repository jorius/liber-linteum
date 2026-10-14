// M4b in the built UI, in Chromium and WebKit (≈ WKWebView): the feedback
// round — a compact header band with the cover as its background, the page
// title in the top bar, and the pickers and chips that came with it.
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const PAGES = {
  'A.md': '# Alpha\n\nhello world\n\nSee [[B]].\n',
  'B.md': '# Beta\n\nThe second page.\n',
};

async function open(page: Page, name: string, opts: { remoteCover?: boolean } = {}) {
  await page.addInitScript(installIpcMock, {
    pages: { ...PAGES },
    editorMode: 'livePreview',
    remoteCover: opts.remoteCover ?? false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue(name);
}

test.use({ viewport: { width: 1280, height: 900 } });

test('M4b §1: with a cover, the text starts in the top 35% of the window', async ({ page }) => {
  // Pages without a `cover:` get a (blocked) remote one: the band shows at full height.
  await open(page, 'A', { remoteCover: true });
  await expect(page.locator('[data-band="cover"]')).toBeVisible();
  const top = await page.locator('.cm-content').evaluate((el) => el.getBoundingClientRect().top);
  expect(top / 900).toBeLessThan(0.35);
  // The title and subtitle are in the top bar, beside Edit · Global view.
  const bar = page.getByRole('banner');
  await expect(bar.getByRole('textbox', { name: 'Page title' })).toHaveValue('A');
  await expect(bar.getByRole('button', { name: 'Edit' })).toBeVisible();
});
