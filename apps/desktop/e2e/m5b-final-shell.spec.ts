// M5b final review (shell): the floating button never covers a control, in
// the editor or the Global View, at any of its three places; the Split
// preview leaves room under its last line (I4).
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';
import { showGlobalView } from './shell';

async function open(page: Page, settings: Record<string, unknown>, editorMode = 'livePreview') {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(installIpcMock, {
    pages: { 'A.md': '# A\n\nText.\n', 'B.md': '# B\n\nMore.\n' },
    editorMode,
    remoteCover: false,
    settings,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name: 'A', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('A');
  return errors;
}

/** Visible buttons whose box meets the floating button's. */
const covered = (page: Page) =>
  page.evaluate(() => {
    const fab = document.querySelector('[data-place] > button[aria-expanded]')!;
    const f = fab.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
      .filter((el) => el !== fab && !el.closest('[data-place]') && el.offsetParent !== null)
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return (
          r.width > 0 &&
          r.left < f.right &&
          r.right > f.left &&
          r.top < f.bottom &&
          r.bottom > f.top
        );
      })
      .map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName);
  });

for (const place of ['bottomRight', 'bottomLeft', 'topRight']) {
  test(`I4: at ${place} the floating button covers no control (editor, Global View)`, async ({
    page,
  }) => {
    const errors = await open(page, { actionButton: place });
    expect(await covered(page)).toEqual([]);
    await showGlobalView(page);
    await expect(page.getByRole('region', { name: 'Global View' })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await covered(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('I4: the Split preview leaves room under its last line for the button', async ({ page }) => {
  await open(page, {}, 'split');
  const pad = await page
    .getByRole('region', { name: 'Preview' })
    .evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
  expect(pad).toBeGreaterThanOrEqual(72);
});
