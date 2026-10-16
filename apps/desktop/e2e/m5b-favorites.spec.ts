// M5b §19: Favorites under the pinned Scratchpad, in the built UI, in
// Chromium and WebKit (≈ WKWebView): favourite a page from its row menu,
// open it from Favorites, reorder by dragging, unfavourite it from the
// header's star.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages: {
      'Scratchpad/q.md': '# q\n',
      'Lore/A.md': '# A\n\nText.\n',
      'Welcome.md': '# Welcome\n',
      'Zed.md': '# Zed\n',
    },
    folders: ['Scratchpad', 'Lore'],
    editorMode: 'livePreview',
    settings: {},
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await expect(page.getByRole('treeitem', { name: 'Welcome', exact: true })).toBeVisible();
  return errors;
}

const row = (page: Page, name: string) => page.getByRole('treeitem', { name, exact: true });
const favorites = (page: Page) => page.getByRole('region', { name: 'Favorites' });

async function favorite(page: Page, name: string) {
  await row(page, name).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add to Favorites' }).click();
}

test('favourite from the menu, open from Favorites, unfavourite from the header star', async ({
  page,
}) => {
  const errors = await open(page);
  await expect(favorites(page)).toHaveCount(0);
  await favorite(page, 'Welcome');
  await expect(favorites(page)).toBeVisible();
  // Under the Scratchpad, above the rest of the files.
  const scratch = (await page.getByRole('treeitem', { name: /^Scratchpad/ }).boundingBox())!;
  const section = (await favorites(page).boundingBox())!;
  const lore = (await row(page, 'Lore').boundingBox())!;
  expect(section.y).toBeGreaterThan(scratch.y);
  expect(lore.y).toBeGreaterThan(section.y);

  await favorites(page).getByRole('button', { name: 'Welcome', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Welcome');
  const star = page.getByRole('button', { name: 'Remove from Favorites' });
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(AXE);
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    const violations = await page.evaluate(async () => {
      const r = await (
        window as unknown as { axe: { run: (n: Element) => Promise<{ violations: unknown[] }> } }
      ).axe.run(document.querySelector('[data-favorites]')!);
      return r.violations;
    });
    expect(violations).toEqual([]);
  }
  await star.click();
  await expect(favorites(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add to Favorites' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expect(errors).toEqual([]);
});

test('favorites reorder by dragging and keep their order across a reload', async ({ page }) => {
  const errors = await open(page);
  await favorite(page, 'Welcome');
  await favorite(page, 'Zed');
  const names = () =>
    favorites(page)
      .locator('li[data-favorite]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-favorite')));
  await expect.poll(names).toEqual(['Welcome.md', 'Zed.md']);
  const zed = (await favorites(page)
    .getByRole('button', { name: 'Zed', exact: true })
    .boundingBox())!;
  const welcome = (await favorites(page)
    .getByRole('button', { name: 'Welcome', exact: true })
    .boundingBox())!;
  await page.mouse.move(zed.x + 10, zed.y + zed.height / 2);
  await page.mouse.down();
  await page.mouse.move(zed.x + 10, zed.y - 4, { steps: 4 });
  await page.mouse.move(welcome.x + 10, welcome.y + 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(names).toEqual(['Zed.md', 'Welcome.md']);
  // The drag opened nothing.
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: /^vault/ }).click();
  await expect.poll(names).toEqual(['Zed.md', 'Welcome.md']);
  expect(errors).toEqual([]);
});
