// M5b §7.1: the search dialog's filter rows never overlap the results, at
// tall and short windows, in Chromium and WebKit (≈ WKWebView). A chip row
// holds at most two lines, then "+N more" expands it.
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const PROJECTS = ['Worldbuilding Reference', 'Narrative & Lore', 'Game Development', 'Scratchpad'];
const TARGETS = [
  'Game Development Overview',
  'Design Principles',
  'GDD',
  'References and Sources',
  'Narrative & Lore Index',
  'Brainstorming Sessions',
  'The Farm',
  'The Origin',
  'Military Ranks',
  'Spacecraft Class Hierarchy',
  'Scientific References',
  'Glossary of Terms',
];

function pages() {
  const out: Record<string, string> = {};
  PROJECTS.forEach((p, i) => {
    out[`${p}/Note ${i}.md`] = `# Note ${i}\n\nSee ${TARGETS.map((t) => `[[${t}]]`).join(' ')}.\n`;
  });
  for (const t of TARGETS) out[`${t}.md`] = `# ${t}\n\nText.\n`;
  return out;
}

async function openSearch(page: Page, height: number) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1280, height });
  await page.addInitScript(installIpcMock, {
    pages: pages(),
    editorMode: 'livePreview',
    remoteCover: false,
    settings: {},
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.keyboard.press('ControlOrMeta+Shift+F');
  const dialog = page.getByRole('dialog', { name: 'Search' });
  await expect(dialog.getByRole('heading', { name: 'Recent' })).toBeVisible();
  return { dialog, errors };
}

async function bottomOf(page: Page, selector: string) {
  return page.evaluate((s) => {
    let max = 0;
    for (const el of document.querySelectorAll(s)) {
      max = Math.max(max, el.getBoundingClientRect().bottom);
    }
    return max;
  }, selector);
}

for (const height of [1000, 700]) {
  test(`filter chips never overlap the results at ${height} px`, async ({ page }) => {
    const { dialog, errors } = await openSearch(page, height);
    const links = dialog.getByRole('group', { name: 'Links to' });
    await expect(links.getByRole('button').first()).toBeVisible();
    const chipsBottom = await bottomOf(page, '[role="dialog"] [role="group"] button');
    const recentTop = (await dialog.getByRole('heading', { name: 'Recent' }).boundingBox())!.y;
    expect(chipsBottom).toBeLessThanOrEqual(recentTop);
    const firstHit = (await dialog.getByRole('option').first().boundingBox())!;
    expect(firstHit.y).toBeGreaterThanOrEqual(chipsBottom);
    expect(errors).toEqual([]);
  });
}

test('a chip row keeps to two lines; "+N more" shows the rest', async ({ page }) => {
  const { dialog } = await openSearch(page, 1000);
  const links = dialog.getByRole('group', { name: 'Links to' });
  const more = links.getByRole('button', { name: /^\+\d+ more$/ });
  await expect(more).toBeVisible();
  const lines = async () =>
    page.evaluate(() => {
      const group = [...document.querySelectorAll('[role="dialog"] [role="group"]')].find(
        (g) =>
          g.getAttribute('aria-labelledby') &&
          document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent === 'Links to',
      )!;
      const tops = new Set(
        [...group.querySelectorAll('button')]
          .filter((b) => b.getBoundingClientRect().height > 0)
          .map((b) => Math.round(b.getBoundingClientRect().top)),
      );
      return tops.size;
    });
  expect(await lines()).toBeLessThanOrEqual(2);
  const shown = await links.getByRole('button').count();
  await more.click();
  await expect(links.getByRole('button', { name: /^\+\d+ more$/ })).toHaveCount(0);
  expect(await links.getByRole('button').count()).toBeGreaterThan(shown - 1);
  // Every link target is now offered.
  for (const t of ['Glossary of Terms', 'Spacecraft Class Hierarchy']) {
    await expect(links.getByRole('button', { name: new RegExp(t) })).toBeVisible();
  }
});

test('only the results scroll; the field and the filters stay in view', async ({ page }) => {
  const { dialog } = await openSearch(page, 700);
  const field = page.getByRole('combobox', { name: 'Search the vault' });
  const before = (await field.boundingBox())!.y;
  const list = dialog.getByRole('listbox');
  await list.hover();
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect((await field.boundingBox())!.y).toBe(before);
  await expect(dialog.getByRole('group', { name: 'Links to' })).toBeInViewport();
});
