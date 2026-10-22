// M5b §7.2: on a Wide-elements page a table wider than the measure takes the
// editor's full width, from its left padding to its right padding, with or
// without line numbers (they move to the editor's left edge, clear of it);
// the text keeps the measure and a narrow table stays with the text.
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

// A worldbuilding "Military Ranks" table (seven columns).
const RANKS = [
  '| Category | Rank | Stars | Typical Color | Conceptual Insignia | Command Role | Authorized Ship Classes |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  '| Pre-Commissioned | Cadet | — | Bronze | No insignia / trainee bar | Trainee — no independent command | None (training only) |',
  '| Junior Officers | Second Lieutenant | — | Gold | No stars / single bar | Junior officer, basic tactical command | Scout |',
  '| Field Officers | Major | ★ | Gold | 1 star | Advanced squad leader | Striker, Freighter |',
].join('\n');

const PAGES: Record<string, string> = {
  'Ranks.md':
    '# Military Ranks\n\nThe Supreme Admiralty stands above conventional military hierarchy. ' +
    'Admirals in this category exercise total control over interstellar fleets.\n\n' +
    `${RANKS}\n\nAfter the table.\n`,
  'Small.md':
    '# Small\n\nSome text before the table, long enough to fill the measure.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n',
};

async function open(page: Page, name: string, lineNumbers: boolean) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.addInitScript(installIpcMock, {
    pages: { ...PAGES },
    editorMode: 'livePreview',
    settings: { pageWidth: 'wide', lineNumbers },
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name, exact: true }).click();
  await expect(page.locator('.cm-liber-widget table')).toBeVisible();
  return errors;
}

/** The table's box, the editor's paddings, the text column and the gutter. */
const geometry = (page: Page) =>
  page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const s = scroller.getBoundingClientRect();
    const gutter = document.querySelector('.cm-gutters')?.getBoundingClientRect() ?? null;
    const content = document.querySelector<HTMLElement>('.cm-content')!;
    const cs = getComputedStyle(content);
    const c = content.getBoundingClientRect();
    const table = document.querySelector('.cm-liber-widget table')!.getBoundingClientRect();
    const numbers = [...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
      .map((n) => n.getBoundingClientRect())
      .filter((r) => r.height > 0 && r.width > 0);
    return {
      // Line numbers sit at the editor's left edge; the padding follows them.
      padLeft: s.left + (gutter ? gutter.width : 0) + 40,
      gutterLeft: gutter ? gutter.left - s.left : null,
      padRight: s.left + scroller.clientWidth - 40,
      textLeft: c.left + parseFloat(cs.paddingLeft),
      textRight: c.right - parseFloat(cs.paddingRight),
      tableLeft: table.left,
      tableRight: table.right,
      numbersRight: numbers.length ? Math.max(...numbers.map((r) => r.right)) : null,
    };
  });

for (const lineNumbers of [false, true]) {
  const label = lineNumbers ? 'with line numbers' : 'without line numbers';

  test(`a wide table spans the editor from padding to padding, ${label}`, async ({ page }) => {
    const errors = await open(page, 'Ranks', lineNumbers);
    await expect
      .poll(async () => {
        const g = await geometry(page);
        return Math.abs(g.tableLeft - g.padLeft) + Math.abs(g.tableRight - g.padRight);
      })
      .toBeLessThanOrEqual(4);
    const g = await geometry(page);
    expect(g.textRight - g.textLeft).toBeLessThanOrEqual(680);
    if (lineNumbers) {
      expect(g.gutterLeft!).toBeLessThanOrEqual(2);
      expect(g.numbersRight!).toBeLessThanOrEqual(g.tableLeft);
    }
    expect(errors).toEqual([]);
  });

  test(`a narrow table stays with the text, ${label}`, async ({ page }) => {
    await open(page, 'Small', lineNumbers);
    const g = await geometry(page);
    expect(Math.abs(g.tableLeft - g.textLeft)).toBeLessThanOrEqual(2);
    expect(g.tableRight).toBeLessThanOrEqual(g.textRight + 1);
  });
}
