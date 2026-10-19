// M6 audio clips in the built UI, in Chromium and WebKit (≈ WKWebView), with a
// mocked backend (no microphone is ever opened): record into the cursor,
// cancel, upload, and play a clip with the app's player — zero network.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

/** A second of 8 kHz mono silence as a WAV file. */
function wav(): Buffer {
  const samples = 8000;
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples * 2, 40);
  return b;
}

async function open(page: Page, pages: Record<string, string>, files: string[] = []) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const outside: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    const local =
      (url.protocol === 'http:' && url.hostname === '127.0.0.1') ||
      url.protocol === 'data:' ||
      url.protocol === 'nimw-asset:' ||
      url.hostname === 'nimw-asset.localhost';
    if (!local) outside.push(r.url());
  });
  await page.addInitScript(installIpcMock, {
    pages,
    files,
    editorMode: 'livePreview',
    settings: {},
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  const name = Object.keys(pages)[0].replace(/\.md$/, '');
  await page.getByRole('treeitem', { name, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue(name);
  return { errors, outside };
}

/** The page's text as last saved (autosave is on), or null before any save. */
const editorText = (page: Page) =>
  page.evaluate(() => {
    const writes = (window as unknown as { __nimwWrites?: { text: string }[] }).__nimwWrites ?? [];
    return writes.length ? writes[writes.length - 1].text : null;
  });

const level = (page: Page, elapsedMs: number) =>
  page.evaluate(
    (ms) =>
      (window as unknown as { __nimwEmit: (e: string, p: unknown) => void }).__nimwEmit(
        'audio:level',
        { recordingId: 7, rms: 0.2, peak: 0.4, elapsedMs: ms, ended: null },
      ),
    elapsedMs,
  );

test('Record clip: Stop & insert puts the clip where the cursor was', async ({ page }) => {
  const { errors, outside } = await open(page, { 'Notes.md': 'Before after\n' });
  const content = page.locator('.cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+ArrowUp');
  for (let i = 0; i < 'Before'.length; i++) await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: 'Record clip' }).click();
  const bar = page.getByRole('region', { name: 'Recorder' });
  await expect(bar.getByRole('combobox', { name: 'Microphone' })).toHaveValue('mic');
  await bar.getByRole('button', { name: 'Start recording' }).click();
  await expect(bar.getByRole('button', { name: 'Stop & insert' })).toBeFocused();
  await level(page, 4000);
  await expect(bar.getByText('0:04')).toBeVisible();
  await page.evaluate(AXE);
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    const violations = await page.evaluate(async () => {
      const r = await (
        window as unknown as {
          axe: { run: (n: Element) => Promise<{ violations: { id: string }[] }> };
        }
      ).axe.run(document.querySelector('[aria-label="Recorder"]')!);
      return r.violations.map((v) => v.id);
    });
    expect(violations, colorScheme).toEqual([]);
  }
  await bar.getByRole('button', { name: 'Stop & insert' }).click();
  await expect(bar).toHaveCount(0);
  await expect
    .poll(() => editorText(page))
    .toMatch(/^Before!\[\[clip-\d{8}-\d{6}\.wav\]\] after\n$/);
  expect(errors).toEqual([]);
  expect(outside).toEqual([]);
});

test('Cancel inserts nothing; Escape asks before discarding', async ({ page }) => {
  const { errors } = await open(page, { 'Notes.md': 'Body\n' });
  await page.locator('.cm-content').click();
  await page.getByRole('button', { name: 'Record clip' }).click();
  const bar = page.getByRole('region', { name: 'Recorder' });
  await bar.getByRole('button', { name: 'Start recording' }).click();
  await page.keyboard.press('Escape');
  await expect(bar.getByText('Discard this recording?')).toBeVisible();
  await bar.getByRole('button', { name: 'Discard' }).click();
  await expect(bar).toHaveCount(0);
  await page.waitForTimeout(800);
  expect(await editorText(page)).toBeNull();
  expect(errors).toEqual([]);
});

test('Upload clip inserts the picked file', async ({ page }) => {
  const { errors } = await open(page, { 'Notes.md': 'Body\n' });
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await page.getByRole('button', { name: 'Record clip' }).click();
  await page.getByRole('button', { name: 'Upload clip…' }).click();
  await expect.poll(() => editorText(page)).toContain('![[memo.wav]]');
  expect(errors).toEqual([]);
});

test('the player plays, pauses and seeks a clip', async ({ page, browserName }) => {
  // Real decoding through a routed request: Chromium only (WebKit loads media
  // outside Playwright's routing); WebKit still checks the controls.
  // Served with byte ranges, as the nimw-asset protocol does (seeking needs them).
  const body = wav();
  await page.route(/nimw-asset/, (route) => {
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
    if (!range) {
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'audio/wav', 'accept-ranges': 'bytes' },
        body,
      });
    }
    const from = Number(range[1]);
    const to = range[2] ? Number(range[2]) : body.length - 1;
    return route.fulfill({
      status: 206,
      headers: {
        'content-type': 'audio/wav',
        'accept-ranges': 'bytes',
        'content-range': `bytes ${from}-${to}/${body.length}`,
      },
      body: body.subarray(from, to + 1),
    });
  });
  const { errors } = await open(page, { 'Notes.md': 'Intro\n\n![[voice.wav]]\n' }, ['voice.wav']);
  const play = page.getByRole('button', { name: 'Play voice.wav' });
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  const slider = page.getByRole('slider', { name: 'Position in voice.wav' });
  await expect(slider).toBeVisible();
  if (browserName === 'chromium') {
    await expect(slider).toHaveAttribute('aria-valuetext', '0:00 of 0:01');
    await play.click();
    await expect(page.getByRole('button', { name: 'Pause voice.wav' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Pause voice.wav' }).click();
    await expect(play).toHaveAttribute('aria-pressed', 'false');
    await slider.focus();
    await page.keyboard.press('End');
    await expect(slider).toHaveAttribute('aria-valuetext', '0:01 of 0:01');
  }
  expect(errors).toEqual([]);
});
