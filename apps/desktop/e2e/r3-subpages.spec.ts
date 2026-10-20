// Round 3 §9: sub-pages — dragging a page onto a page makes it a folder page
// with the dragged page inside, and Move to… can pick a page — in Chromium
// and WebKit.
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages: {
      'Projects.md': '# Projects\n',
      'Ideas.md': '# Ideas\n',
      'Welcome.md': '# Welcome\n',
    },
    editorMode: 'livePreview',
    settings: {},
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await expect(page.getByRole('treeitem', { name: 'Welcome' })).toBeVisible();
  return errors;
}

const row = (page: Page, name: string) => page.getByRole('treeitem', { name, exact: true });

test('dragging a page onto a page makes it a folder page with the dragged page inside', async ({
  page,
}) => {
  const errors = await open(page);
  const from = (await row(page, 'Ideas').boundingBox())!;
  const to = (await row(page, 'Projects').boundingBox())!;
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 50, from.y + from.height / 2, { steps: 3 });
  await page.mouse.move(to.x + 40, to.y + to.height / 2, { steps: 8 });
  await expect(row(page, 'Projects')).toHaveClass(/drop/);
  await page.mouse.up();
  // Projects is now one row (folder + its page) holding Ideas.
  await expect(row(page, 'Projects')).toHaveAttribute('aria-expanded', /true|false/);
  const renames = await page.evaluate(
    () => (window as unknown as { __liberRenames?: unknown[] }).__liberRenames ?? [],
  );
  expect(renames).toContainEqual({ from: 'Ideas.md', to: 'Projects/Ideas.md' });
  if ((await row(page, 'Projects').getAttribute('aria-expanded')) === 'false') {
    await row(page, 'Projects').locator('[data-twisty]').click();
  }
  await expect(row(page, 'Ideas')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Move to… can choose a page; "Add sub-page" adds one under a page', async ({ page }) => {
  const errors = await open(page);
  await row(page, 'Welcome').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('treeitem', { name: /^Projects/ }).dblclick();
  await expect(dialog).toBeHidden();
  const renames = await page.evaluate(
    () => (window as unknown as { __liberRenames?: unknown[] }).__liberRenames ?? [],
  );
  expect(renames).toContainEqual({ from: 'Welcome.md', to: 'Projects/Welcome.md' });
  // Add sub-page on a plain page: it becomes a folder page with a new page inside.
  await row(page, 'Ideas').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add sub-page' }).click();
  await expect(page.getByRole('textbox', { name: 'Rename' })).toBeVisible();
  await expect(row(page, 'Ideas')).toHaveAttribute('aria-expanded', 'true');
  expect(errors).toEqual([]);
});
