// M3a in the built UI, in Chromium and WebKit (≈ WKWebView): the Global View
// — levels, Drill-down and Expand, the editor from a card, pinned positions
// across a reload, edge toggles and keyboard-only use.
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const PAGES = {
  'Alpha/One.md': '# One\n\nSee [[Two]].\n',
  'Alpha/Two.md': '# Two\n\nThe second.\n',
  'Beta/Three.md': '# Three\n\nSee [[One]].\n',
  'Welcome.md': '# Welcome\n\nStart here.\n',
};

async function globalView(page: Page, settings: Record<string, unknown> = {}) {
  await page.addInitScript(installIpcMock, {
    pages: { ...PAGES },
    editorMode: 'livePreview',
    settings,
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('button', { name: 'Global view' }).click();
  await expect(page.getByRole('region', { name: 'Global View' })).toBeVisible();
}

const card = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const crumbs = (page: Page) => page.getByRole('navigation', { name: 'Global View path' });

test('level 0 shows projects and root pages; a click drills in; the breadcrumb goes back', async ({
  page,
}) => {
  await globalView(page);
  for (const name of ['Alpha', 'Beta', 'Welcome']) await expect(card(page, name)).toBeVisible();
  await card(page, 'Alpha').click();
  await expect(card(page, 'One')).toBeVisible();
  await expect(card(page, 'Two')).toBeVisible();
  await expect(card(page, 'Beta')).toHaveCount(0);
  await expect(crumbs(page).getByRole('button', { name: 'Vault' })).toBeVisible();
  await expect(crumbs(page).getByText('Alpha')).toHaveAttribute('aria-current', 'page');
  await crumbs(page).getByRole('button', { name: 'Vault' }).click();
  await expect(card(page, 'Beta')).toBeVisible();
});

test('expand in place adds the children beside the card; a second click collapses', async ({
  page,
}) => {
  await globalView(page, { globalViewMode: 'expand' });
  await card(page, 'Alpha').click();
  await expect(card(page, 'One')).toBeVisible();
  await expect(card(page, 'Beta')).toBeVisible();
  await expect(page.locator('[data-gv-edge="tree"]')).toHaveCount(2);
  await card(page, 'Alpha').click();
  await expect(card(page, 'One')).toHaveCount(0);
});

test('a double click opens the page in the editor', async ({ page }) => {
  await globalView(page);
  await card(page, 'Welcome').dblclick();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Welcome');
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-pressed', 'true');
});

test('a dragged card keeps its place after a reload (GV-31); Reset layout restores it', async ({
  page,
}) => {
  await globalView(page);
  const node = page.locator('.react-flow__node[data-id="Beta"]');
  const before = await node.boundingBox();
  const grip = node.locator('.gv-grip');
  const at = (await grip.boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  await page.mouse.move(at.x + 120, at.y + 160, { steps: 8 });
  await page.mouse.up();
  const moved = (await node.boundingBox())!;
  expect(moved.y - before!.y).toBeGreaterThan(30);
  // Saved after the debounce; a reload (restart) reads it back.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('nimw-e2e-layout') ?? ''))
    .toContain('Beta');
  await page.reload();
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('button', { name: 'Global view' }).click();
  await expect(card(page, 'Beta')).toBeVisible();
  const transform = () => node.evaluate((n) => (n as HTMLElement).style.transform);
  const pinned = await transform();
  await page.getByRole('button', { name: 'Reset layout' }).click();
  await expect.poll(transform).not.toBe(pinned);
});

test('links from inside folders draw one aggregated edge; its toggle hides it', async ({
  page,
}) => {
  await globalView(page);
  const aggregated = page.locator('[data-gv-edge="link-aggregated"]');
  await expect(aggregated).toHaveCount(1);
  const toggle = page.getByRole('button', { name: 'Links from inside folders' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(aggregated).toHaveCount(0);
});

test('keyboard only: arrows move, Enter opens, Escape goes back, Shift+Enter edits (GV-18)', async ({
  page,
}) => {
  await globalView(page);
  await card(page, 'Alpha').focus();
  await page.keyboard.press('ArrowRight');
  await expect(card(page, 'Beta')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card(page, 'Three')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(card(page, 'Alpha')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(card(page, 'Welcome')).toBeFocused();
  await page.keyboard.press('Shift+Enter');
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Welcome');
});
