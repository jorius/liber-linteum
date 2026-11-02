// 0.1.3 in the built UI, in Chromium and WebKit (≈ WKWebView): the empty
// space below the explorer's rows is the vault root — a drop there moves an
// item to the root and a click there clears the selection, so New page lands
// at the root — even when the tree is longer than the sidebar.
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // More folders than the sidebar shows; the last one holds a page.
  const folders = Array.from({ length: 40 }, (_, i) => `Folder ${i + 10}`);
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.addInitScript(installIpcMock, {
    pages: { 'Welcome.md': '# Welcome\n', 'Zed/Note.md': '# Note\n' },
    folders: [...folders, 'Zed'],
    editorMode: 'livePreview',
    settings: {},
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await expect(row(page, 'Zed')).toBeAttached();
  return errors;
}

const row = (page: Page, name: string) => page.getByRole('treeitem', { name, exact: true });
const strip = (page: Page) => page.locator('[data-vault-root]');

/** Scrolls the tree to its end; the point in the empty strip below the rows. */
async function stripPoint(page: Page) {
  await strip(page).evaluate((el) => el.parentElement!.scrollTo(0, el.parentElement!.scrollHeight));
  const box = (await strip(page).boundingBox())!;
  const scroller = (await strip(page).evaluate((el) => {
    const r = el.parentElement!.getBoundingClientRect();
    return { bottom: r.bottom };
  }))!;
  const bottom = Math.min(box.y + box.height, scroller.bottom);
  return { x: box.x + 60, y: bottom - 28 };
}

test('a page dragged to the empty space below a long tree moves to the vault root', async ({
  page,
}) => {
  const errors = await open(page);
  await row(page, 'Zed').click();
  await expect(row(page, 'Zed')).toHaveAttribute('aria-expanded', 'true');
  const to = await stripPoint(page);
  const from = (await row(page, 'Note').boundingBox())!;
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 50, from.y + from.height / 2, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await expect(strip(page)).toHaveClass(/drop/);
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __liberRenames?: unknown[] }).__liberRenames ?? [],
      ),
    )
    .toContainEqual({ from: 'Zed/Note.md', to: 'Note.md' });
  expect(errors).toEqual([]);
});

test('a click below the rows clears the selection: New page goes to the vault root', async ({
  page,
}) => {
  const errors = await open(page);
  await row(page, 'Zed').click();
  await expect(row(page, 'Zed')).toHaveAttribute('aria-selected', 'true');
  const at = await stripPoint(page);
  await page.mouse.click(at.x, at.y);
  await expect(row(page, 'Zed')).not.toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'New page' }).click();
  await expect(page.getByRole('textbox', { name: 'Rename' })).toBeVisible();
  await expect(page.locator('li[data-path="Untitled.md"]')).toHaveAttribute('aria-level', '1');
  expect(errors).toEqual([]);
});
