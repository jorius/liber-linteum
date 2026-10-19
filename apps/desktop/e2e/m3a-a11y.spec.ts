// axe on the Global View in a real engine (M3a NFR-10). jsdom can't tell
// what text is visible, so rules such as label-content-name-mismatch only
// run here (final review m5).
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { showGlobalView } from './shell';
import { installIpcMock } from './ipcMock';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

const PAGES = {
  'Alpha/One.md': '---\nsubtitle: First\n---\n# One\n\nSee [[Two]] and [[Three]].\n',
  'Alpha/Two.md': '# Two\n\nThe second.\n',
  'Beta/Three.md': '# Three\n\nSee [[One]].\n',
  'Welcome.md': '# Welcome\n\nStart here.\n',
};

for (const theme of ['light', 'dark']) {
  test(`the Global View is axe-clean in a real engine (${theme})`, async ({ page }) => {
    await page.addInitScript(installIpcMock, {
      pages: { ...PAGES },
      editorMode: 'livePreview',
      settings: { theme },
      remoteCover: false,
    });
    await page.goto('/');
    await page.getByRole('button', { name: /^vault/ }).click();
    await showGlobalView(page);
    await expect(page.getByRole('button', { name: 'Alpha', exact: true })).toBeVisible();
    await page.evaluate(AXE);
    const violations = await page.evaluate(async () => {
      const { axe } = window as unknown as {
        axe: {
          run: (
            el: Element,
            opts: object,
          ) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
        };
      };
      const region = document.querySelector('section[aria-label="Global View"]')!;
      const res = await axe.run(region, { resultTypes: ['violations'] });
      return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`);
    });
    expect(violations).toEqual([]);
  });
}
