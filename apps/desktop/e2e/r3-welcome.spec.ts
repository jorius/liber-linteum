// R3 §7: the Welcome screen as a launcher, in Chromium and WebKit (≈ WKWebView).
// The ways to start sit beside the recent vaults, and stack above them when
// the window is narrow.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

async function start(page: Page, width: number) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width, height: 800 });
  await page.addInitScript(installIpcMock, {
    pages: {},
    editorMode: 'livePreview',
    settings: {},
    remoteCover: false,
  });
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Recent vaults' })).toBeVisible();
  return errors;
}

const box = async (page: Page, name: string) =>
  (await page.getByRole('heading', { name, exact: true }).boundingBox())!;

test('wide: the ways to start on the left, recent vaults on the right', async ({ page }) => {
  const errors = await start(page, 1200);
  const title = await box(page, 'Liber Linteum');
  const recent = await box(page, 'Recent vaults');
  // The start column is 330 px wide.
  expect(title.x).toBeLessThan(330);
  expect(recent.x).toBeGreaterThanOrEqual(330);
  expect(Math.abs(recent.y - title.y)).toBeLessThan(40);

  await page.evaluate(AXE);
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: { run: (n: Element) => Promise<{ violations: { id: string }[] }> };
      }
    ).axe;
    return (await axe.run(document.body)).violations.map((v) => v.id);
  });
  expect(violations).toEqual([]);
  expect(errors).toEqual([]);
});

test('narrow: the columns stack, the ways to start first', async ({ page }) => {
  const errors = await start(page, 600);
  const language = (await page.getByRole('button', { name: 'Español' }).boundingBox())!;
  const recent = await box(page, 'Recent vaults');
  expect(recent.y).toBeGreaterThan(language.y + language.height);
  // Nothing scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(600);
  expect(errors).toEqual([]);
});
