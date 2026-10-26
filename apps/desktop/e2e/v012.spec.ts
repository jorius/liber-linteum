// 0.1.2 in the built UI, in Chromium (≈ WebView2 on Windows): an image opens
// in its own view, right-clicking one offers the system's viewer and its
// folder, dragging its corner in Live Preview writes the width into the link,
// and the sidebar's Open list keeps the pages being edited.
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

/** A Windows WebView2 user agent: vault files go through
 *  http://liber-asset.localhost, which the test can serve. */
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';

/** A 400 × 300 image. */
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
  '<rect width="400" height="300" fill="#2a6"/></svg>';

test.use({ userAgent: WINDOWS_UA });

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|liber-asset\.localhost)/, (route) => route.abort());
  await page.route(/^http:\/\/liber-asset\.localhost\//, (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: SVG }),
  );
  await page.addInitScript(installIpcMock, {
    pages: {
      'A.md': '# A\n\nhello\n',
      'Pics.md': '# Pics\n\n![[attachments/sky.png]]\n\nafter\n',
      // A non-page entry lists the image in the tree.
      'attachments/sky.png': '',
    },
    folders: ['attachments'],
    files: ['attachments/sky.png'],
    editorMode: 'livePreview',
    remoteCover: false,
    settings: {},
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await expect(page.getByRole('treeitem', { name: 'A', exact: true })).toBeVisible();
  return errors;
}

async function openPage(page: Page, name: string) {
  await page
    .getByRole('tree', { name: 'Files' })
    .getByRole('treeitem', { name, exact: true })
    .click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue(name);
}

const writes = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __liberWrites?: { path: string; text: string }[] }).__liberWrites ??
      [],
  );

test('an image opens in its own view; its menu opens it or shows its folder', async ({ page }) => {
  const errors = await open(page);
  await page.getByRole('treeitem', { name: /^attachments/ }).click();
  await page.getByRole('treeitem', { name: /^sky/ }).click();
  const img = page.locator('img[data-image-view]');
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(400);
  await expect(page.getByText('400 × 300 px')).toBeVisible();

  await img.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Image menu' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: /^Show in/ }).click();
  await expect(menu).toBeHidden();
  expect(
    await page.evaluate(() => (window as unknown as { __liberReveals: string[] }).__liberReveals),
  ).toEqual(['attachments/sky.png']);

  await img.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open in default app' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Open', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __liberExternalOpens?: string[] }).__liberExternalOpens,
      ),
    )
    .toEqual(['attachments/sky.png']);
  expect(errors).toEqual([]);
});

test('dragging an image’s corner in Live Preview writes its width into the link', async ({
  page,
}) => {
  const errors = await open(page);
  await openPage(page, 'Pics');
  const img = page.locator('.cm-editor img');
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(400);
  await img.hover();
  const handle = page.locator('.cm-liber-resize');
  await expect(handle).toBeVisible();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 100, box.y, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => (await writes(page)).filter((w) => w.path === 'Pics.md').at(-1)?.text)
    .toMatch(/!\[\[attachments\/sky\.png\|(\d+)\]\]/);
  const text = (await writes(page)).filter((w) => w.path === 'Pics.md').at(-1)!.text;
  const width = Number(/\|(\d+)\]\]/.exec(text)![1]);
  expect(width).toBeGreaterThan(250);
  expect(width).toBeLessThan(350);
  await expect
    .poll(() => img.evaluate((el) => Math.round(el.getBoundingClientRect().width)))
    .toBe(width);
  expect(errors).toEqual([]);
});

test('the Open list keeps the pages being edited, at the top of the sidebar', async ({ page }) => {
  const errors = await open(page);
  const list = page.getByRole('region', { name: 'Open' });
  await expect(list).toHaveCount(0);
  await openPage(page, 'Pics');
  await openPage(page, 'A');
  await expect(list.getByRole('listitem')).toHaveCount(2);
  const top = (await list.boundingBox())!;
  const files = (await page.getByRole('tree', { name: 'Files' }).boundingBox())!;
  expect(top.y).toBeLessThan(files.y);

  await list.getByRole('button', { name: 'Pics', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Pics');
  await list.getByRole('button', { name: 'Close Pics' }).click({ force: true });
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('A');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  // Kept across a reload, like the favorites.
  await page.reload();
  await page.getByRole('button', { name: /^vault/ }).click();
  await expect(page.getByRole('region', { name: 'Open' }).getByRole('listitem')).toHaveCount(1);
  expect(errors).toEqual([]);
});
