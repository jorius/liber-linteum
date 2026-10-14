// M3b in the built UI, in Chromium and WebKit (≈ WKWebView): connecting
// cards (Connect to… and a click, the keyboard, a drag from the connect
// handle), editing a relationship from its edge, deleting it, and picking a
// folder's index note.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

const PAGES = {
  'Alpha/One.md': '# One\n\nThe first.\n',
  'Beta/Three.md': '# Three\n\nThird.\n',
  'Beta/Four.md': '# Four\n\nFourth.\n',
  'Notes.md': '# Notes\n\nLoose notes.\n',
  'Welcome.md': '# Welcome\n\nStart here.\n',
};

async function globalView(page: Page, pages: Record<string, string> = PAGES) {
  await page.addInitScript(installIpcMock, {
    pages: { ...pages },
    editorMode: 'livePreview',
    settings: {},
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('button', { name: 'Global view' }).click();
  await expect(page.getByRole('button', { name: 'Welcome', exact: true })).toBeVisible();
}

const card = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const writesTo = (page: Page, path: string) =>
  page.evaluate(
    (p) =>
      (
        (window as unknown as { __nimwWrites?: { path: string; text: string }[] }).__nimwWrites ??
        []
      )
        .filter((w) => w.path === p)
        .map((w) => w.text),
    path,
  );

test('Connect to…, then a click on a card: the source page gains the relationship and an edge', async ({
  page,
}) => {
  await globalView(page);
  await page.getByRole('button', { name: 'Connections of Welcome' }).click();
  await page.getByRole('menuitem', { name: 'Connect to…' }).click();
  await expect(page.getByRole('status', { name: 'Connecting' })).toContainText(
    'Pick the card to connect: Welcome → ?',
  );
  await card(page, 'Notes').click();
  await expect
    .poll(() => writesTo(page, 'Welcome.md'))
    .toEqual(['---\nrelated:\n  - "[[Notes]]"\n---\n# Welcome\n\nStart here.\n']);
  await expect(page.getByRole('status', { name: 'Connecting' })).toHaveCount(0);
  await expect(page.locator('[data-gv-edge="manual"]')).toHaveCount(1);
});

test('by keyboard: the menu, Connect to…, an arrow to the target, Enter', async ({ page }) => {
  await globalView(page);
  // Level 0 in three columns: Alpha, Beta, Notes over Welcome.
  await page.getByRole('button', { name: 'Connections of Notes' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Connect to…' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card(page, 'Notes')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(card(page, 'Welcome')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => writesTo(page, 'Notes.md')).toHaveLength(1);
  expect((await writesTo(page, 'Notes.md'))[0]).toContain('"[[Welcome]]"');
});

test('a drag from the connect handle onto another card relates them', async ({ page }) => {
  await globalView(page);
  const from = (await page.getByRole('button', { name: 'Connections of Welcome' }).boundingBox())!;
  const to = (await card(page, 'Notes').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(() => writesTo(page, 'Welcome.md'))
    .toEqual(['---\nrelated:\n  - "[[Notes]]"\n---\n# Welcome\n\nStart here.\n']);
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('a relationship’s edge opens its dialog: label and arrow, then delete', async ({ page }) => {
  await globalView(page, {
    ...PAGES,
    'Welcome.md': '---\nrelated:\n  - "[[Notes]]"\n---\n# Welcome\n\nStart here.\n',
  });
  const hit = page.locator('[data-gv-hit]');
  await expect(hit).toHaveCount(1);
  await hit.click({ force: true });
  const dialog = page.getByRole('dialog', { name: 'Relationships between Notes and Welcome' });
  await expect(dialog).toBeVisible();
  const row = dialog.getByRole('group', { name: 'Welcome → Notes' });
  await row.getByRole('textbox', { name: 'Label' }).fill('inspired');
  await row.getByRole('checkbox', { name: 'Arrow to Notes' }).check();
  await row.getByRole('button', { name: 'Save' }).click();
  await expect
    .poll(async () => (await writesTo(page, 'Welcome.md')).at(-1))
    .toBe(
      '---\nrelated:\n  - { link: "[[Notes]]", label: inspired, directed: true }\n---\n# Welcome\n\nStart here.\n',
    );
  await expect(page.locator('[data-gv-arrow]')).toHaveCount(1);

  // The dialog is axe-clean in a real engine.
  await page.evaluate(AXE);
  const violations = await page.evaluate(async () => {
    const { axe } = window as unknown as {
      axe: { run: (el: Element) => Promise<{ violations: { id: string }[] }> };
    };
    const res = await axe.run(document.querySelector('[role="dialog"]')!);
    return res.violations.map((v) => v.id);
  });
  expect(violations).toEqual([]);

  await row.getByRole('button', { name: 'Delete relationship' }).click();
  await expect
    .poll(async () => (await writesTo(page, 'Welcome.md')).at(-1))
    .toBe('# Welcome\n\nStart here.\n');
  await expect(dialog.getByText('No relationships yet.', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('[data-gv-edge="manual"]')).toHaveCount(0);
});

test('a folder without an index note: pick one, and its card previews it', async ({ page }) => {
  await globalView(page);
  await page.getByRole('button', { name: 'Connections of Beta' }).click();
  await page.getByRole('menuitem', { name: 'Pick index note…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Index note for Beta' });
  await dialog.getByRole('radio', { name: 'Four' }).check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Beta, project' })).toContainText('Project · Beta');
});

test('the keyboard comes back to the connect button after Relationships… (NFR-10, final review I2)', async ({
  page,
}) => {
  await globalView(page, {
    ...PAGES,
    'Welcome.md': '---\nrelated:\n  - "[[Notes]]"\n---\n# Welcome\n\nStart here.\n',
  });
  const button = page.getByRole('button', { name: 'Connections of Welcome' });
  await button.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Relationships…' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Relationships of Welcome' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(button).toBeFocused();
});
