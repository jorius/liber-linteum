// Part B in the built UI, in Chromium and WebKit (≈ WKWebView): a left click
// on a diagram still edits it; a right click opens Preview, a dialog that
// zooms (wheel) and pans (drag) the drawn diagram and closes on Escape, also
// in Focus mode, which stays on.
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const PAGE =
  '# D\n\nBefore.\n\n```mermaid\nflowchart LR\n  A[Start] --> B[End]\n```\n\n' +
  'Middle.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nAfter.\n';

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages: { 'D.md': PAGE },
    editorMode: 'livePreview',
    remoteCover: false,
    settings: { editorMode: 'livePreview' },
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name: 'D', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('D');
  await expect(diagram(page).locator('svg')).toBeVisible({ timeout: 15_000 });
  return errors;
}

const diagram = (page: Page) =>
  page.locator('.cm-content').getByRole('img', { name: 'Diagram: flowchart LR' });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Diagram preview' });
const layer = (page: Page) => dialog(page).getByRole('img', { name: 'Diagram' });

async function preview(page: Page) {
  await diagram(page).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Preview' }).click();
  await expect(layer(page).locator('svg')).toBeVisible();
}

test.use({ viewport: { width: 1280, height: 900 } });

test('a left click on the diagram still shows its source', async ({ page }) => {
  const errors = await open(page);
  await diagram(page).click();
  await expect(page.locator('.cm-line', { hasText: '```mermaid' })).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('right-click on block maths opens the menu', async ({ page }) => {
  await open(page);
  await page.locator('.cm-content div[data-liber="math"]').click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'Diagram menu' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Preview' }).click();
  await expect(dialog(page).locator('.katex')).toBeVisible();
});

test('Preview zooms with the wheel, pans with a drag, closes on Escape', async ({ page }) => {
  const errors = await open(page);
  await preview(page);
  const percent = dialog(page).getByText(/^\d+%$/);
  const before = Number((await percent.textContent())!.replace('%', ''));
  const box = (await layer(page).boundingBox())!;
  // Opens fitted: the whole drawing, at its natural size, inside the viewport.
  const frame = (await layer(page).locator('..').boundingBox())!;
  expect(box.width).toBeGreaterThan(50);
  expect(box.x).toBeGreaterThanOrEqual(frame.x);
  expect(box.y).toBeGreaterThanOrEqual(frame.y);
  expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
  expect(box.y + box.height).toBeLessThanOrEqual(frame.y + frame.height);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await expect
    .poll(async () => Number((await percent.textContent())!.replace('%', '')))
    .toBeGreaterThan(Math.max(before, 100));

  const transform = () => layer(page).evaluate((el) => (el as HTMLElement).style.transform);
  const moved = await transform();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 60, { steps: 5 });
  await page.mouse.up();
  await expect.poll(transform).not.toBe(moved);
  expect(await transform()).toContain('translate(');

  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('in Focus mode, Escape closes the preview and Focus mode stays on', async ({ page }) => {
  await open(page);
  await page.locator('.cm-line', { hasText: 'After.' }).click();
  await page.keyboard.press('ControlOrMeta+Alt+KeyZ');
  await expect(page.locator('[data-focus-strip]')).toBeVisible();
  await preview(page);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('[data-focus-strip]')).toBeVisible();
});
