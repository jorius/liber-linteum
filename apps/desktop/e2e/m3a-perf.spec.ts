// NFR-03 probe (M3a final review I2): a level of ≤ 200 cards renders in
// < 300 ms at the edge density of the 10k reference vault's level 0 (~2,200
// aggregated pairs, counts in the tens). Timings depend on the machine, so it
// runs only when asked: NIMW_PERF=1 pnpm --filter @nimw/desktop exec
// playwright test m3a-perf (after `vite build`). Reference numbers are in
// the M3a spec, §13.
import { expect, test, type Page } from '@playwright/test';
import { showEditor, showGlobalView } from './shell';
import { installIpcMock } from './ipcMock';

test.skip(!process.env.NIMW_PERF, 'timing probe: set NIMW_PERF=1 to run it');

/** `gv_edges` answered directly (the mock's own link resolution would be
 *  timed too): every card linked to `partners` others, aggregated, ×5–×44. */
function denseEdges({ partners }: { partners: number }) {
  const w = window as unknown as {
    __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown, opts: unknown) => unknown };
  };
  const inner = w.__TAURI_INTERNALS__.invoke;
  w.__TAURI_INTERNALS__.invoke = async (cmd, args, opts) => {
    if (cmd !== 'gv_edges') return inner(cmd, args, opts);
    const shown = (args as { visible: string[] }).visible.filter((p) => !p.endsWith('.md'));
    const n = shown.length;
    const out = [];
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) {
      for (let k = 1; k <= partners; k++) {
        const j = (i + 7 * k) % n;
        const [from, to] = shown[i] < shown[j] ? [shown[i], shown[j]] : [shown[j], shown[i]];
        if (i === j || seen.has(`${from}|${to}`)) continue;
        seen.add(`${from}|${to}`);
        const count = 5 + ((i * 31 + k * 17) % 40);
        out.push({ from, to, kind: 'link', aggregated: true, directed: false, count, label: null });
      }
    }
    return out;
  };
}

function projects(n: number) {
  const pages: Record<string, string> = { 'Welcome.md': '# Welcome\n' };
  for (let i = 0; i < n; i++) pages[`P${String(i).padStart(3, '0')}/n${i}.md`] = `# N${i}\n`;
  return pages;
}

const now = (page: Page) =>
  page.evaluate(
    () => new Promise<number>((done) => requestAnimationFrame(() => done(performance.now()))),
  );

for (const [cards, partners] of [
  [94, 28], // 2,632 aggregated pairs
  [200, 17], // 3,400
] as const) {
  test(`NFR-03: ${cards} project cards with ${partners * cards} aggregated edges`, async ({
    page,
  }) => {
    await page.addInitScript(installIpcMock, {
      pages: projects(cards),
      editorMode: 'livePreview',
      settings: {},
      remoteCover: false,
    });
    await page.addInitScript(denseEdges, { partners });
    await page.goto('/');
    await page.getByRole('button', { name: /^vault/ }).click();
    const opens: number[] = [];
    for (let run = 0; run < 3; run++) {
      const t0 = await page.evaluate(() => performance.now());
      await showGlobalView(page);
      await page.waitForFunction(
        (n) =>
          document.querySelectorAll('[data-gv-card]').length > n &&
          document.querySelectorAll('[data-gv-edge]').length > 0,
        cards,
        { polling: 'raf' },
      );
      opens.push((await now(page)) - t0);
      await showEditor(page);
    }
    console.log(test.info().project.name, `${cards} cards: ${opens.map(Math.round)} ms`);
    expect(Math.max(...opens)).toBeLessThan(300);
  });
}
