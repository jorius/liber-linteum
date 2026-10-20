// NFR-03 probe (M4 final review I2): typing in Split on a large note must not
// stall while the block gutter maps the pane's blocks. The worst frame after
// a keystroke (the pane re-renders 150 ms later) is measured three times.
// Timings depend on the machine, so it runs only when asked:
// LIBER_PERF=1 pnpm --filter @liber/desktop exec playwright test m4-perf (after
// `vite build`).
//
// Reference (Apple silicon, headless, worst frames in ms, Chromium / WebKit):
//   M3b (c307c86):          100 KB 40–55 / 37–61    200 KB 56–71 / 38–78
//   M4 before the fix:      100 KB 88–99 / 104–112  200 KB 338–368 / 381–417
//   M4 with linear anchors: 100 KB 26–51 / 19–58    200 KB 47–68 / 35–79
// Mapping the blocks itself takes 1–2 ms at 200 KB, the block model ≤ 1 ms.
// Spelling (Live Preview, 200 KB, worst frame within 1 s of a keystroke,
// Chromium / WebKit): off 18–21 / 19–22, on 20–30 / 19–27. A keystroke only
// resets the 300 ms timer; the check after the pause adds ≤ ~9 ms once.
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

test.skip(!process.env.LIBER_PERF, 'timing probe: set LIBER_PERF=1 to run it');

/** Paragraphs, an H2 every tenth block and a nested list every seventh. */
function note(size: number): string {
  const parts: string[] = [];
  let length = 0;
  for (let i = 1; length < size; i++) {
    const part =
      i % 10 === 0
        ? `## Heading ${i}`
        : i % 7 === 0
          ? `- item ${i} a\n- item ${i} b\n  - nested ${i}`
          : `Paragraph ${i} with some *emphasis* and a [[Link ${i}]] and more words to fill the line.`;
    parts.push(part);
    length += part.length + 2;
  }
  return `${parts.join('\n\n')}\n`;
}

async function open(
  page: Page,
  text: string,
  editorMode = 'split',
  settings: Record<string, unknown> = {},
) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(installIpcMock, {
    pages: { 'M.md': text },
    editorMode,
    settings,
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name: 'M' }).click();
  if (editorMode !== 'split') {
    await expect(page.locator('.cm-content')).toBeVisible({ timeout: 20_000 });
    return;
  }
  const pane = page.getByRole('region', { name: 'Preview' });
  await expect(pane.locator('[data-source-start]').first()).toBeVisible({ timeout: 20_000 });
}

/** The longest frame within `ms` after `act`. */
async function worstFrame(page: Page, act: () => Promise<void>, ms: number): Promise<number> {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: { worst: number; run: boolean } };
    w.__frames = { worst: 0, run: true };
    let last = performance.now();
    const loop = () => {
      const now = performance.now();
      w.__frames.worst = Math.max(w.__frames.worst, now - last);
      last = now;
      if (w.__frames.run) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await act();
  await page.waitForTimeout(ms);
  return page.evaluate(() => {
    const w = window as unknown as { __frames: { worst: number; run: boolean } };
    w.__frames.run = false;
    return Math.round(w.__frames.worst);
  });
}

for (const size of [100_000, 200_000]) {
  test(`NFR-03: a keystroke in Split on a ${size / 1000} KB note`, async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, note(size));
    await page.waitForTimeout(1500);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Home');
    const frames: number[] = [];
    for (let k = 0; k < 3; k++) {
      frames.push(await worstFrame(page, () => page.keyboard.type('x'), 1000));
    }
    console.log(test.info().project.name, `${size / 1000} KB: worst frame ${frames.join(', ')} ms`);
  });
}

// Spell checking (spec §5): the same keystrokes in Live Preview with spelling
// on and off; the re-check runs 300 ms after typing, inside the window.
for (const spellcheck of [false, true]) {
  test(`spelling ${spellcheck ? 'on' : 'off'}: a keystroke in Live Preview on a 200 KB note`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await open(page, note(200_000), 'livePreview', { spellcheck });
    await page.waitForTimeout(1500);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Home');
    const frames: number[] = [];
    for (let k = 0; k < 3; k++) {
      frames.push(await worstFrame(page, () => page.keyboard.type('x'), 1000));
    }
    console.log(
      test.info().project.name,
      `spelling ${spellcheck ? 'on' : 'off'}: worst frame ${frames.join(', ')} ms`,
    );
  });
}
