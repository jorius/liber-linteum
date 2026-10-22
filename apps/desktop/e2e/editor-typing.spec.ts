// Typing in the editor, in the built UI, in Chromium and WebKit
// (≈ WKWebView): brackets and quotes that close themselves (Settings →
// Editor), and a selection wrapped by * = ~.
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';
import { openSettings } from './shell';

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installIpcMock, {
    pages: {
      'A.md': '# Alpha\n\nfirst line\n\nsecond line\n',
      'B.md': '# Bravo\n\nThe second page.\n',
    },
    editorMode: 'source',
    remoteCover: false,
    settings: {},
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name: 'A', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('A');
  return errors;
}

const line = (page: Page, text: string) => page.locator('.cm-line', { hasText: text });

test('brackets and quotes close themselves; the closer steps over; a selection is wrapped', async ({
  page,
}) => {
  const errors = await open(page);
  await line(page, 'first line').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' (see "here")');
  await expect(line(page, 'first line')).toHaveText('first line (see "here")');
  // Backspace in an empty pair takes both.
  await page.keyboard.type(' [');
  await expect(line(page, 'first line')).toHaveText('first line (see "here") []');
  await page.keyboard.press('Backspace');
  await expect(line(page, 'first line')).toHaveText('first line (see "here") ');
  // An apostrophe stays one.
  await page.keyboard.type("it's");
  await expect(line(page, 'first line')).toHaveText('first line (see "here") it\'s');

  // ** around a selection, by pressing * twice.
  await line(page, 'second line').dblclick({ position: { x: 5, y: 5 } });
  await page.keyboard.type('**');
  await expect(line(page, '**second**')).toHaveText('**second** line');

  // [[ makes one ]], and the autocomplete steps over it.
  await line(page, '**second**').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' [[b.');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('B.md');
  await page.waitForTimeout(100); // CodeMirror's interaction delay
  await page.keyboard.press('Enter');
  await expect(line(page, '**second**')).toHaveText('**second** line [[B|Bravo]]');
  expect(errors).toEqual([]);
});

test('Settings → Editor → Auto-close brackets and quotes turns it off', async ({ page }) => {
  const errors = await open(page);
  await openSettings(page, 'Editor');
  const box = page.getByRole('checkbox', { name: 'Auto-close brackets and quotes' });
  await expect(box).toBeChecked();
  await box.uncheck();
  await page.keyboard.press('Escape');
  await line(page, 'first line').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' (x');
  await expect(line(page, 'first line')).toHaveText('first line (x');
  expect(errors).toEqual([]);
});
