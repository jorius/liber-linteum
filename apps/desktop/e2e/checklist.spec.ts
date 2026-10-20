// Feedback 2026-10-13: a task checkbox must toggle with a click in Live
// Preview (not only by typing `x` between the brackets).
import { expect, test } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const PAGES = { 'tasks.md': '# Tasks\n\n- [ ] one\n- [x] two\n\nEnd.\n' };

async function writes(page: import('@playwright/test').Page) {
  return page.evaluate(() =>
    ((window as unknown as { __liberWrites?: { text: string }[] }).__liberWrites ?? []).map(
      (w) => w.text,
    ),
  );
}

async function open(page: import('@playwright/test').Page, editorMode: string) {
  await page.addInitScript(installIpcMock, { pages: PAGES, editorMode });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name: 'tasks' }).click();
}

test('clicking a task checkbox in Live Preview toggles it in the file', async ({ page }) => {
  await open(page, 'livePreview');
  const one = page.getByRole('checkbox', { name: 'one' });
  await expect(one).not.toBeChecked();
  await one.click();
  await expect(page.getByRole('checkbox', { name: 'one' })).toBeChecked();
  await expect.poll(() => writes(page)).toContainEqual(expect.stringContaining('- [x] one'));
  // And back.
  await page.getByRole('checkbox', { name: 'two' }).click();
  await expect.poll(() => writes(page)).toContainEqual(expect.stringContaining('- [ ] two'));
});

test('the checkbox stays clickable with the cursor on its line', async ({ page }) => {
  await open(page, 'livePreview');
  await page.locator('.cm-line', { hasText: 'one' }).click({ position: { x: 200, y: 5 } });
  await page.getByRole('checkbox', { name: 'one' }).click();
  await expect.poll(() => writes(page)).toContainEqual(expect.stringContaining('- [x] one'));
});

test('a checkbox in the Split pane toggles the task', async ({ page }) => {
  await open(page, 'split');
  await page
    .getByRole('region', { name: /preview/i })
    .getByRole('checkbox', { name: 'one' })
    .click();
  await expect.poll(() => writes(page)).toContainEqual(expect.stringContaining('- [x] one'));
});
