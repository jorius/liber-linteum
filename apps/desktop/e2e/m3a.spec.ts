// M3a in the built UI, in Chromium and WebKit (≈ WKWebView): the Global View
// — levels, Drill-down and Expand, the editor from a card, pinned positions
// across a reload, edge toggles and keyboard-only use.
import { expect, test, type Page } from '@playwright/test';
import { showGlobalView } from './shell';
import { installIpcMock } from './ipcMock';

const PAGES = {
  'Alpha/One.md': '# One\n\nSee [[Two]].\n',
  'Alpha/Two.md': '# Two\n\nThe second.\n',
  'Beta/Three.md': '# Three\n\nSee [[One]].\n',
  'Welcome.md': '# Welcome\n\nStart here.\n',
};

async function globalView(
  page: Page,
  settings: Record<string, unknown> = {},
  latencyMs = 0,
  pages: Record<string, string> = PAGES,
) {
  await page.addInitScript(installIpcMock, {
    pages: { ...pages },
    editorMode: 'livePreview',
    settings,
    remoteCover: false,
  });
  // A real backend answers later than the mock: every command waits a little.
  if (latencyMs) {
    await page.addInitScript((ms) => {
      type Invoke = (...args: unknown[]) => Promise<unknown>;
      const ipc = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } })
        .__TAURI_INTERNALS__;
      const invoke = ipc.invoke;
      ipc.invoke = async (...args) => {
        await new Promise((r) => setTimeout(r, ms));
        return invoke(...args);
      };
    }, latencyMs);
  }
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await showGlobalView(page);
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
  await expect(page.getByRole('region', { name: 'Page' })).toBeVisible();
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
  await showGlobalView(page);
  await expect(card(page, 'Beta')).toBeVisible();
  const transform = () => node.evaluate((n) => (n as HTMLElement).style.transform);
  const pinned = await transform();
  await page.getByRole('button', { name: 'Reset layout' }).click();
  await expect.poll(transform).not.toBe(pinned);
});

test('a drag is saved under its own level even when the breadcrumb is clicked at once (final review I1)', async ({
  page,
}) => {
  await globalView(page);
  await card(page, 'Alpha').click();
  await expect(card(page, 'One')).toBeVisible();
  const grip = page.locator('.react-flow__node[data-id="Alpha/One.md"] .gv-grip');
  const at = (await grip.boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  await page.mouse.move(at.x + 120, at.y + 160, { steps: 8 });
  await page.mouse.up();
  // Back to the vault before the 300 ms save.
  await crumbs(page).getByRole('button', { name: 'Vault' }).click();
  await expect(card(page, 'Beta')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('nimw-e2e-layout') ?? '{}') as object),
    )
    .toHaveProperty(['Alpha', 'Alpha/One.md']);
  const layout = await page.evaluate(
    () => JSON.parse(localStorage.getItem('nimw-e2e-layout') ?? '{}') as Record<string, object>,
  );
  expect(layout[''] ?? {}).not.toHaveProperty(['Alpha/One.md']);
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
  // Back on the card that opened the level (final review m13).
  await page.keyboard.press('Escape');
  await expect(card(page, 'Beta')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(card(page, 'Welcome')).toBeFocused();
  await page.keyboard.press('Shift+Enter');
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Welcome');
});

for (const latencyMs of [0, 40]) {
  test(`the keyboard follows: Shift+Enter and ⌘1 land in the editor, ⌘2 back on the card, IPC +${latencyMs} ms (final review I4)`, async ({
    page,
  }) => {
    await globalView(page, {}, latencyMs);
    await card(page, 'Alpha').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(card(page, 'Welcome')).toBeFocused();
    await page.keyboard.press('Shift+Enter');
    await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Welcome');
    await expect(page.locator('.cm-content')).toBeFocused();
    await page.keyboard.press('ControlOrMeta+2');
    await expect(card(page, 'Welcome')).toBeFocused();
    await page.keyboard.press('ControlOrMeta+1');
    await expect(page.locator('.cm-content')).toBeFocused();
    await page.keyboard.type('!');
    await expect(page.locator('.cm-content')).toContainText('!');
  });
}

test('a double click lands in the editor with the keyboard (final review I4)', async ({ page }) => {
  await globalView(page);
  await card(page, 'Alpha').click();
  await card(page, 'One').dblclick();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('One');
  await expect(page.locator('.cm-content')).toBeFocused();
});

/** Level 0 and Alpha have two cards each, so after drilling into Alpha its
 *  first card stands where Alpha stood (the reviewer's probe). */
const TWO_BY_TWO = {
  'Alpha/One.md': '# One\n\nSee [[Two]].\n',
  'Alpha/Two.md': '# Two\n',
  'Welcome.md': '# Welcome\n',
};

/** Two presses at one spot, `gapMs` apart, that the OS counts as a double
 *  click (macOS allows about 0.5 s): the first drills in after 240 ms. */
async function slowDoubleClick(page: Page, name: string, gapMs: number) {
  const target = card(page, name);
  await target.click({ trial: true }); // waits until the card stands still
  const box = (await target.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(gapMs);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
}

test('a slow double click on a folder leaves it open once; the card now under the pointer stays shut (final review I5)', async ({
  page,
}) => {
  await globalView(page, {}, 0, TWO_BY_TWO);
  await slowDoubleClick(page, 'Alpha', 350);
  await page.waitForTimeout(400); // past the single-click wait of the second press
  await expect(crumbs(page).getByText('Alpha')).toHaveAttribute('aria-current', 'page');
  await expect(card(page, 'One')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Global View' })).toBeVisible();
});

test('a slow double click on a page opens that page (final review I5)', async ({ page }) => {
  await globalView(page, {}, 0, TWO_BY_TWO);
  await slowDoubleClick(page, 'Welcome', 350);
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Welcome');
});
