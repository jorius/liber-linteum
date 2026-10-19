// M4 in the built UI, in Chromium and WebKit (≈ WKWebView): dragging blocks
// in the Split pane, keyboard moves, undo, and axe with a gutter showing.
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

async function open(page: Page, text: string, settings: Record<string, unknown> = {}) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(installIpcMock, {
    pages: { 'M.md': text },
    editorMode: 'split',
    settings,
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name: 'M' }).click();
  const pane = page.getByRole('region', { name: 'Preview' });
  await expect(pane.locator('[data-source-start]').first()).toBeVisible();
  return pane;
}

/** The source as the editor shows it (the Split's left side). */
const source = (page: Page) =>
  page.locator('.cm-content').evaluate((el) =>
    [...el.querySelectorAll('.cm-line')]
      .map((l) => l.textContent)
      .join('\n')
      .trimEnd(),
  );

/** The last text autosaved (the editor renders only the lines in view, so a
 *  long note is read from what was written). */
const saved = (page: Page) =>
  page.evaluate(() => {
    const writes = (window as unknown as { __nimwWrites?: { text: string }[] }).__nimwWrites ?? [];
    return writes.length ? writes[writes.length - 1].text : null;
  });

/** Drags the grip of the block `from` to the point (x, y) of the page. */
async function drag(page: Page, from: Locator, name: string, x: number, y: number) {
  await from.hover();
  const grip = page.getByRole('button', { name: `Drag to reorder: ${name}` });
  const g = (await grip.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 8 });
  await expect(page.locator('[data-drop-line]')).toBeVisible();
  await page.mouse.up();
}

test('acceptance: P3 dragged above P1 reads P3, P1, P2; one undo restores the order', async ({
  page,
}) => {
  const pane = await open(page, 'P1 *one*\n\nP2\n\nP3 **three**\n');
  const p1 = (await pane.getByText('P1').boundingBox())!;
  await drag(page, pane.getByText('P3'), 'P3 three', p1.x + 40, p1.y + 2);
  await expect.poll(() => source(page)).toBe('P3 **three**\n\nP1 *one*\n\nP2');
  await expect(
    page.getByRole('status').filter({ hasText: 'Moved P3 three to the top of the page.' }),
  ).toBeAttached();
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => source(page)).toBe('P1 *one*\n\nP2\n\nP3 **three**');
});

test('a block’s grip can be reached with the pointer: its gutter stays while the pointer crosses to it', async ({
  page,
}) => {
  const pane = await open(page, 'P1\n\nP2 is a paragraph\n\nP3\n');
  const p2 = (await pane.getByText('P2 is').boundingBox())!;
  await page.mouse.move(p2.x + 30, p2.y + p2.height / 2);
  const grip = page.getByRole('button', { name: 'Drag to reorder: P2 is a paragraph' });
  const g = (await grip.boundingBox())!;
  // Gradually, as a hand would: through the gap between the block and its grip.
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2, { steps: 20 });
  await expect(grip).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move up' })).toBeVisible();
});

test('final review M8: the first block’s hidden tab-stop gutter can’t be grabbed until it has the keyboard', async ({
  page,
}) => {
  const pane = await open(page, 'P1\n\nP2\n\nP3\n');
  await pane.getByText('P3').hover();
  // P1's gutter is there for Tab, unseen: the pointer goes through it.
  const grip = page.getByRole('button', { name: 'Drag to reorder: P1' });
  const g = (await grip.boundingBox())!;
  const hit = () =>
    page.evaluate(
      ([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-grip]'),
      [g.x + g.width / 2, g.y + g.height / 2],
    );
  expect(await hit()).toBe(false);
  // With the keyboard, it shows and takes the pointer.
  await grip.focus();
  expect(await hit()).toBe(true);
});

test('acceptance: a heading dragged below the next section takes its paragraphs along', async ({
  page,
}) => {
  const pane = await open(page, '## A\n\nA1\n\nA2\n\n## B\n\nB1\n');
  const b1 = (await pane.getByText('B1').boundingBox())!;
  await drag(page, pane.getByRole('heading', { name: 'A' }), 'A', b1.x + 40, b1.y + b1.height + 6);
  await expect.poll(() => source(page)).toBe('## B\n\nB1\n\n## A\n\nA1\n\nA2');
});

test('a list item dropped right of an item’s text nests under it', async ({ page }) => {
  const pane = await open(page, '- a\n- b\n- c\n');
  const a = (await pane.locator('li', { hasText: 'a' }).first().boundingBox())!;
  await drag(page, pane.locator('li', { hasText: 'c' }), 'c', a.x + 60, a.y + a.height - 1);
  await expect.poll(() => source(page)).toBe('- a\n  - c\n- b');
});

test('review focus: in a scrolled pane, a drag near the top edge scrolls up and drops where the line shows', async ({
  page,
}) => {
  const paras = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}.`);
  const pane = await open(page, `${paras.join('\n\n')}\n`);
  await pane.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const last = pane.getByText('Paragraph 40.');
  await last.hover();
  const grip = page.getByRole('button', { name: 'Drag to reorder: Paragraph 40.' });
  const g = (await grip.boundingBox())!;
  const box = (await pane.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + 40, box.y + 8, { steps: 6 });
  // Held near the top edge, the pane scrolls up.
  await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBeLessThan(200);
  await page.mouse.up();
  await expect.poll(() => saved(page)).not.toBeNull();
  const lines = (await saved(page))!.trimEnd().split('\n\n');
  expect(lines.indexOf('Paragraph 40.')).toBeLessThan(30);
  expect([...lines].sort()).toEqual([...paras].sort());
});

test('keyboard only: ↓ to the next block, Alt+↑ moves it, Enter picks a block up and drops it', async ({
  page,
}) => {
  const pane = await open(page, 'P1\n\nP2\n\nP3\n');
  await page.getByRole('button', { name: 'Drag to reorder: P1' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Drag to reorder: P2' })).toBeFocused();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => source(page)).toBe('P2\n\nP1\n\nP3');
  // The pane shows the move (keys wait for it), and P2's grip keeps the keyboard.
  await expect(pane.locator('[data-source-start]').first()).toHaveText('P2');
  await expect(page.getByRole('button', { name: 'Drag to reorder: P2' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect.poll(() => source(page)).toBe('P1\n\nP3\n\nP2');
});

test('keyboard only, fast: keys pressed before the pane shows a move wait for it, none lost', async ({
  page,
}) => {
  await open(page, 'P1\n\nP2\n\nP3\n');
  await page.getByRole('button', { name: 'Drag to reorder: P1' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Drag to reorder: P2' })).toBeFocused();
  // No waiting between keys: the pane is still drawing the move.
  for (const key of ['Alt+ArrowUp', 'Enter', 'ArrowDown', 'Enter']) await page.keyboard.press(key);
  await expect.poll(() => source(page)).toBe('P1\n\nP3\n\nP2');
  await expect(page.getByRole('button', { name: 'Drag to reorder: P2' })).toBeFocused();
});

test('final review C2: text that changes during a drag — the dragged block moves, not the one now at its index', async ({
  page,
}) => {
  const pane = await open(page, 'P1\n\nP2\n\nP3\n');
  await pane.getByText('P3').hover();
  const grip = page.getByRole('button', { name: 'Drag to reorder: P3' });
  const g = (await grip.boundingBox())!;
  const p1 = (await pane.getByText('P1').boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(p1.x + 40, p1.y + 2, { steps: 6 });
  await expect(page.locator('[data-drop-line]')).toBeVisible();
  // Meanwhile a paragraph is typed at the top (the editor has the keyboard:
  // WebKit/macOS buttons don't take focus on click), and the pane shows it.
  await page.locator('.cm-content').evaluate((el) => (el as HTMLElement).focus());
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('New');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(pane.locator('[data-source-start]').first()).toHaveText('New');
  const p1b = (await pane.getByText('P1').boundingBox())!;
  await page.mouse.move(p1b.x + 40, p1b.y + 2, { steps: 3 });
  await page.mouse.up();
  await expect.poll(() => source(page)).toBe('New\n\nP3\n\nP1\n\nP2');
});

/** The note of final review C2's first trigger, after typing X in "Para". */
async function typedNextToRule(page: Page) {
  const pane = await open(page, 'Intro\n\n---\n\nPara\n\n- a\n- b\n\n> q\n\nEnd\n');
  await page.locator('.cm-line', { hasText: /^Para$/ }).click();
  await page.keyboard.press('End');
  await page.keyboard.type('X');
  await expect(pane.getByText('ParaX')).toBeVisible();
  await pane.locator('blockquote').hover();
  const grip = page.getByRole('button', { name: 'Drag to reorder: q' });
  await grip.focus();
  return grip;
}

test('final review C2: after typing next to a --- rule, a picked-up quote moves — not a list item', async ({
  page,
}) => {
  await typedNextToRule(page);
  await page.keyboard.press('Enter');
  for (let k = 0; k < 10; k++) await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('status').filter({ hasText: 'Before Intro' })).toBeAttached();
  await page.keyboard.press('Enter');
  await expect.poll(() => source(page)).toBe('> q\n\nIntro\n\n---\n\nParaX\n\n- a\n- b\n\nEnd');
});

test('final review C2: after typing next to a --- rule, Alt+↑ on the quote never moves another block', async ({
  page,
}) => {
  await typedNextToRule(page);
  await page.keyboard.press('Alt+ArrowUp');
  await page.waitForTimeout(300);
  // Above the list; or, if the pane's re-parse misreads the list after the
  // rule (the C2 trigger), cancelled with a message: never a list item.
  expect([
    'Intro\n\n---\n\nParaX\n\n> q\n\n- a\n- b\n\nEnd',
    'Intro\n\n---\n\nParaX\n\n- a\n- b\n\n> q\n\nEnd',
  ]).toContain(await source(page));
  if ((await source(page)).endsWith('> q\n\nEnd')) {
    await expect(
      page.getByText('That block changed, so it wasn’t moved. Try again.'),
    ).toBeVisible();
  }
});

test('final review I1: a <details> block still folds the Markdown after it, and has a gutter', async ({
  page,
}) => {
  const pane = await open(
    page,
    '<details>\n<summary>More</summary>\n\nHidden *text*\n\n</details>\n\nAfter\n',
  );
  await expect(pane.locator('details > p')).toHaveText('Hidden text');
  await expect(pane.getByText('Hidden')).toBeHidden();
  await pane.locator('summary').hover();
  await expect(page.getByRole('button', { name: 'Drag to reorder: HTML block' })).toBeVisible();
});

for (const theme of ['light', 'dark']) {
  test(`axe-clean with a block gutter open (${theme})`, async ({ page }) => {
    const pane = await open(page, '# T\n\nP1\n\n- a\n- b\n', { theme });
    await pane.locator('li', { hasText: 'b' }).hover();
    await page.getByRole('group', { name: 'b' }).hover();
    await page.evaluate(AXE);
    const violations = await page.evaluate(async () => {
      const { axe } = window as unknown as {
        axe: {
          run: (
            el: Element,
            o: object,
          ) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
        };
      };
      const region = document.querySelector('[role="region"][aria-label="Preview"]')!;
      const res = await axe.run(region, { resultTypes: ['violations'] });
      return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`);
    });
    expect(violations).toEqual([]);
  });
}
