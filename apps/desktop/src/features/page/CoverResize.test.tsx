// Cover resize: the cover band's bottom edge is a separator the user drags
// (or moves with the keyboard) to set the page's cover height, kept per page
// in `.liber/vault.json` (never in the note).
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { useCoverHeightStore } from '../../stores/coverHeightStore';
import { resetEditorStore } from '../../stores/editorStore';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { fakeDisk, type FakeDisk } from '../../test/fakeDisk';
import { PageScreen } from '../../test/pageScreen';

const open = (path: string) => act(() => usePageStore.getState().load(path));

/** Covers resolve next to the page (enough for tests). */
const resolveCovers = (args: Record<string, unknown>) =>
  (args.targets as { kind: string; target: string }[]).map((t) =>
    t.kind === 'cover' ? t.target : null,
  );

const COVER = '---\ncover: sky.png\n---\n# Rex\n';
/** jsdom's window is 768 px tall: 60% of it is 460 px. */
const MAX = 460;

let heights: Record<string, number>;

function disk(files: Record<string, string>): FakeDisk {
  const reply = () => ({
    attachments: { mode: 'subfolder', path: 'attachments' },
    obsidian: null,
    overrideObsidian: false,
    pageWidth: null,
    pageWidths: {},
    coverHeights: { ...heights },
  });
  return fakeDisk(files, {
    links_resolve: resolveCovers,
    vault_settings_get: reply,
    cover_height_set: (args) => {
      const { path, height } = args as { path: string; height: number | null };
      if (height === null) delete heights[path];
      else heights[path] = Math.min(2000, Math.max(132, Math.round(height)));
      return reply();
    },
  });
}

const band = () => document.querySelector<HTMLElement>('[data-band]')!;
const shown = () => band().style.getPropertyValue('--cover-height');
const handle = () => screen.getByRole('separator', { name: 'Cover height' });
const saves = (d: FakeDisk) =>
  d.calls.filter(([cmd]) => cmd === 'cover_height_set').map(([, args]) => args);

const pointer = (target: Element, type: string, y: number) =>
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: 400,
        clientY: y,
        pointerId: 1,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
      }),
    );
  });

async function openWithCover(files: Record<string, string>, path: string) {
  const d = disk(files);
  render(<PageScreen />);
  await act(() => useCoverHeightStore.getState().load());
  await open(path);
  await waitFor(() => expect(document.querySelector('img[data-cover]')).not.toBeNull());
  return d;
}

function setWindowHeight(px: number) {
  Object.defineProperty(window, 'innerHeight', { value: px, configurable: true, writable: true });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

beforeEach(() => {
  heights = {};
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useCoverHeightStore.setState({ pages: {}, loaded: false });
  useVaultStore.setState({ info: { name: 'Vault', root: '/v', report: {} as never } });
});
afterEach(async () => {
  Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true, writable: true });
  usePageStore.getState().clear();
  resetEditorStore();
  await resetVaultStore();
  clearMocks();
});

describe('cover resize', () => {
  it('a cover band takes the default height from Settings, a page with its own keeps it; a page without a cover has no handle', async () => {
    heights = { 'Own.md': 320 };
    await openWithCover({ 'Rex.md': COVER, 'Own.md': COVER, 'Plain.md': '# Plain\n' }, 'Rex.md');
    expect(shown()).toBe('200px');
    const h = handle();
    expect(h).toHaveAttribute('aria-orientation', 'horizontal');
    expect(h).toHaveAttribute('aria-valuenow', '200');
    expect(h).toHaveAttribute('aria-valuemin', '132');
    expect(h).toHaveAttribute('aria-valuemax', String(MAX));
    expect(h).toHaveAttribute('tabindex', '0');
    act(() => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, coverHeight: 280 } }));
    expect(shown()).toBe('280px');
    await open('Own.md');
    await waitFor(() => expect(shown()).toBe('320px'));
    await open('Plain.md');
    await waitFor(() => expect(band().dataset.band).toBe('plain'));
    expect(screen.queryByRole('separator', { name: 'Cover height' })).not.toBeInTheDocument();
    expect(shown()).toBe('');
  });

  it('dragging the bottom edge sets the height live; release saves it for the page, not in the note', async () => {
    const d = await openWithCover({ 'Rex.md': COVER }, 'Rex.md');
    const h = handle();
    await pointer(h, 'pointerdown', 300);
    await pointer(h, 'pointermove', 350);
    expect(h).toHaveAttribute('aria-valuenow', '250');
    expect(shown()).toBe('250px');
    await pointer(h, 'pointermove', 400);
    expect(shown()).toBe('300px');
    expect(saves(d)).toEqual([]);
    await pointer(h, 'pointerup', 400);
    await waitFor(() => expect(saves(d)).toEqual([{ path: 'Rex.md', height: 300 }]));
    expect(heights).toEqual({ 'Rex.md': 300 });
    expect(shown()).toBe('300px');
    expect(d.writes()).toEqual([]);
  });

  it('a press without a move saves nothing', async () => {
    const d = await openWithCover({ 'Rex.md': COVER }, 'Rex.md');
    await pointer(handle(), 'pointerdown', 300);
    await pointer(handle(), 'pointerup', 300);
    expect(saves(d)).toEqual([]);
  });

  it('the height stays between 132 px and 60% of the window while dragging', async () => {
    const d = await openWithCover({ 'Rex.md': COVER }, 'Rex.md');
    const h = handle();
    await pointer(h, 'pointerdown', 300);
    await pointer(h, 'pointermove', 3000);
    expect(shown()).toBe(`${MAX}px`);
    await pointer(h, 'pointermove', -1000);
    expect(shown()).toBe('132px');
    await pointer(h, 'pointerup', -1000);
    await waitFor(() => expect(saves(d)).toEqual([{ path: 'Rex.md', height: 132 }]));
  });

  it('keyboard: ↑/↓ move 16 px (Shift 64), Home and End go to the ends, Escape restores, Enter saves', async () => {
    const d = await openWithCover({ 'Rex.md': COVER }, 'Rex.md');
    const h = handle();
    act(() => h.focus());
    await userEvent.keyboard('{ArrowDown}');
    expect(h).toHaveAttribute('aria-valuenow', '216');
    await userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}');
    expect(shown()).toBe('280px');
    await userEvent.keyboard('{ArrowUp}');
    expect(shown()).toBe('264px');
    await userEvent.keyboard('{Escape}');
    expect(shown()).toBe('200px');
    expect(saves(d)).toEqual([]);
    await userEvent.keyboard('{Home}');
    expect(shown()).toBe('132px');
    await userEvent.keyboard('{End}');
    expect(shown()).toBe(`${MAX}px`);
    await userEvent.keyboard('{Shift>}{ArrowUp}{/Shift}{Enter}');
    await waitFor(() => expect(saves(d)).toEqual([{ path: 'Rex.md', height: MAX - 64 }]));
    expect(shown()).toBe(`${MAX - 64}px`);
    expect(h).toHaveFocus();
  });

  it('leaving the handle saves a height set from the keyboard', async () => {
    const d = await openWithCover({ 'Rex.md': COVER }, 'Rex.md');
    act(() => handle().focus());
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(saves(d)).toEqual([]);
    act(() => handle().blur());
    await waitFor(() => expect(saves(d)).toEqual([{ path: 'Rex.md', height: 232 }]));
  });

  it('a double-click, or Delete, puts the default back; focus stays on the handle', async () => {
    heights = { 'Rex.md': 320 };
    const d = await openWithCover({ 'Rex.md': COVER }, 'Rex.md');
    expect(shown()).toBe('320px');
    await userEvent.dblClick(handle());
    await waitFor(() => expect(saves(d)).toEqual([{ path: 'Rex.md', height: null }]));
    expect(shown()).toBe('200px');
    expect(heights).toEqual({});
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(heights).toEqual({ 'Rex.md': 216 }));
    await userEvent.keyboard('{Delete}');
    await waitFor(() => expect(heights).toEqual({}));
    expect(shown()).toBe('200px');
    expect(handle()).toHaveFocus();
  });

  it('a shorter window shows less, without changing what is stored', async () => {
    heights = { 'Rex.md': 450 };
    const d = await openWithCover({ 'Rex.md': COVER }, 'Rex.md');
    expect(shown()).toBe('450px');
    setWindowHeight(500);
    expect(shown()).toBe('300px');
    expect(handle()).toHaveAttribute('aria-valuemax', '300');
    setWindowHeight(900);
    expect(shown()).toBe('450px');
    expect(saves(d)).toEqual([]);
  });

  it('reposition works at any height: the handle steps aside while placing the image', async () => {
    heights = { 'Rex.md': 320 };
    await openWithCover({ 'Rex.md': COVER }, 'Rex.md');
    await userEvent.click(screen.getByRole('button', { name: 'Reposition' }));
    const slider = screen.getByRole('slider', { name: 'Cover position' });
    expect(slider).toHaveFocus();
    expect(screen.queryByRole('separator', { name: 'Cover height' })).not.toBeInTheDocument();
    expect(shown()).toBe('320px');
    await userEvent.keyboard('{ArrowUp}');
    expect(document.querySelector<HTMLImageElement>('img[data-cover]')!.style.objectPosition).toBe(
      '50% 55%',
    );
    await userEvent.keyboard('{Escape}');
    expect(handle()).toBeInTheDocument();
  });

  it('a failed save puts the previous height back', async () => {
    fakeDisk(
      { 'Rex.md': COVER },
      {
        links_resolve: resolveCovers,
        cover_height_set: () => {
          throw { kind: 'io', message: 'disk full' };
        },
      },
    );
    render(<PageScreen />);
    await open('Rex.md');
    await waitFor(() => expect(document.querySelector('img[data-cover]')).not.toBeNull());
    const h = handle();
    await pointer(h, 'pointerdown', 300);
    await pointer(h, 'pointermove', 380);
    await pointer(h, 'pointerup', 380);
    await waitFor(() => expect(shown()).toBe('200px'));
  });

  it('has no axe violations with the handle', async () => {
    await openWithCover({ 'Rex.md': COVER }, 'Rex.md');
    act(() => handle().focus());
    fireEvent.mouseOver(band());
    const violations = await axe
      .run(document.querySelector('main') ?? document.body, {
        rules: { 'color-contrast': { enabled: false } },
      })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
  });
});
