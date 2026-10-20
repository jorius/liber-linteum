// Side covers (M4b part 3 §3): a cover can sit on top (the header band), or
// as a tall strip on the left or right of the page; the strip's inner edge
// resizes it, a side cover repositions in both axes, and a window too narrow
// for a strip shows the cover on top. Placement and width live in
// `.liber/vault.json`; only the focus point (`cover-x`, `cover-y`) is written
// to the note.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { useCoverLayoutStore } from '../../stores/coverLayoutStore';
import { resetEditorStore } from '../../stores/editorStore';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { fakeDisk, type FakeDisk } from '../../test/fakeDisk';
import { PageScreen } from '../../test/pageScreen';

const open = (path: string) => act(() => usePageStore.getState().load(path));

const resolveCovers = (args: Record<string, unknown>) =>
  (args.targets as { kind: string; target: string }[]).map((t) =>
    t.kind === 'cover' ? t.target : null,
  );

const COVER = '---\ncover: sky.png\n---\n# Rex\n';

let sides: Record<string, string>;
let widths: Record<string, number>;

function disk(files: Record<string, string>): FakeDisk {
  const reply = () => ({
    attachments: { mode: 'subfolder', path: 'attachments' },
    obsidian: null,
    overrideObsidian: false,
    pageWidth: null,
    pageWidths: {},
    coverHeights: {},
    coverSides: { ...sides },
    coverWidths: { ...widths },
  });
  return fakeDisk(files, {
    links_resolve: resolveCovers,
    vault_settings_get: reply,
    cover_side_set: (args) => {
      const { path, side } = args as { path: string; side: string };
      if (side === 'top') delete sides[path];
      else sides[path] = side;
      return reply();
    },
    cover_width_set: (args) => {
      const { path, width } = args as { path: string; width: number | null };
      if (width === null) delete widths[path];
      else widths[path] = Math.min(2000, Math.max(160, Math.round(width)));
      return reply();
    },
  });
}

async function openWithCover(files: Record<string, string>, path: string) {
  const d = disk(files);
  render(<PageScreen />);
  await act(() => useCoverLayoutStore.getState().load());
  await open(path);
  await waitFor(() => expect(document.querySelector('img[data-cover]')).not.toBeNull());
  return d;
}

const strip = () => document.querySelector<HTMLElement>('[data-cover-strip]');
const layout = () => document.querySelector<HTMLElement>('[data-cover-layout]')!;
const band = () => document.querySelector<HTMLElement>('[data-band]')!;
const calls = (d: FakeDisk, cmd: string) =>
  d.calls.filter(([c]) => c === cmd).map(([, args]) => args);
const placement = () => screen.getByRole('radiogroup', { name: 'Cover placement' });

/** A ResizeObserver stand-in reporting the page area's width. */
let observed: ((width: number) => void)[] = [];
class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe() {
    observed.push((width) =>
      this.cb([{ contentRect: { width } } as ResizeObserverEntry], this as never),
    );
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  sides = {};
  widths = {};
  observed = [];
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useCoverLayoutStore.setState({ sides: {}, widths: {} });
  useVaultStore.setState({ info: { name: 'Vault', root: '/v', report: {} as never } });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  usePageStore.getState().clear();
  resetEditorStore();
  await resetVaultStore();
  clearMocks();
});

describe('side covers (M4b part 3 §3)', () => {
  it('Top, Left and Right: a radio group among the cover controls; Left moves the cover into a strip before the text and saves it', async () => {
    const d = await openWithCover({ 'Rex.md': COVER }, 'Rex.md');
    const group = placement();
    const top = within(group).getByRole('radio', { name: 'Cover on top' });
    expect(top).toHaveAttribute('aria-checked', 'true');
    expect(strip()).toBeNull();
    expect(band().dataset.band).toBe('cover');
    await userEvent.click(within(group).getByRole('radio', { name: 'Cover on the left' }));
    await waitFor(() => expect(strip()).not.toBeNull());
    expect(calls(d, 'cover_side_set')).toEqual([{ path: 'Rex.md', side: 'left' }]);
    expect(strip()!.dataset.coverStrip).toBe('left');
    // The image is the strip's; the band is plain; the strip comes first.
    expect(strip()!.querySelector('img[data-cover]')).not.toBeNull();
    expect(band().dataset.band).toBe('plain');
    expect(layout().firstElementChild).toBe(strip());
    expect(strip()!.style.getPropertyValue('--cover-width')).toBe('280px');
    expect(d.writes()).toEqual([]);
    // The controls moved into the strip; focus went with the chosen radio.
    expect(within(strip()!).getByRole('radiogroup', { name: 'Cover placement' })).toBe(placement());
    expect(within(placement()).getByRole('radio', { name: 'Cover on the left' })).toHaveFocus();
  });

  it('Right puts the strip after the text; Top puts the band back', async () => {
    sides = { 'Rex.md': 'right' };
    const d = await openWithCover({ 'Rex.md': COVER }, 'Rex.md');
    expect(strip()!.dataset.coverStrip).toBe('right');
    expect(layout().lastElementChild).toBe(strip());
    const group = placement();
    expect(within(group).getByRole('radio', { name: 'Cover on the right' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await userEvent.click(within(group).getByRole('radio', { name: 'Cover on top' }));
    await waitFor(() => expect(strip()).toBeNull());
    expect(band().dataset.band).toBe('cover');
    expect(calls(d, 'cover_side_set')).toEqual([{ path: 'Rex.md', side: 'top' }]);
  });

  it('the radio group is one Tab stop; arrow keys move the choice', async () => {
    const d = await openWithCover({ 'Rex.md': COVER }, 'Rex.md');
    const radios = within(placement()).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    radios[0].focus();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(strip()?.dataset.coverStrip).toBe('left'));
    const left = within(placement()).getByRole('radio', { name: 'Cover on the left' });
    expect(left).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(strip()?.dataset.coverStrip).toBe('right'));
    expect(calls(d, 'cover_side_set').map((a) => (a as { side: string }).side)).toEqual([
      'left',
      'right',
    ]);
  });

  it('the strip has its own width; its inner edge resizes it from the pointer and keyboard and saves per page', async () => {
    sides = { 'Rex.md': 'left' };
    widths = { 'Rex.md': 300 };
    const d = await openWithCover({ 'Rex.md': COVER }, 'Rex.md');
    const edge = screen.getByRole('separator', { name: 'Cover width' });
    expect(edge).toHaveAttribute('aria-orientation', 'vertical');
    expect(edge).toHaveAttribute('aria-valuenow', '300');
    expect(edge).toHaveAttribute('aria-valuemin', '160');
    // jsdom's window is 1024 px wide: 45% of it.
    expect(edge).toHaveAttribute('aria-valuemax', '460');
    // A left strip's edge is on its right: → widens it.
    edge.focus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowLeft}');
    expect(edge).toHaveAttribute('aria-valuenow', '316');
    expect(strip()!.style.getPropertyValue('--cover-width')).toBe('316px');
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(calls(d, 'cover_width_set')).toEqual([{ path: 'Rex.md', width: 316 }]),
    );
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}{End}');
    expect(edge).toHaveAttribute('aria-valuenow', '460');
    await userEvent.keyboard('{Escape}');
    expect(edge).toHaveAttribute('aria-valuenow', '316');
    // Dragging moves the edge with the pointer.
    const at = (type: string, x: number) =>
      act(() => {
        edge.dispatchEvent(
          new PointerEvent(type, { bubbles: true, clientX: x, clientY: 300, pointerId: 1 }),
        );
      });
    await at('pointerdown', 500);
    await at('pointermove', 540);
    expect(edge).toHaveAttribute('aria-valuenow', '356');
    await at('pointerup', 540);
    await waitFor(() =>
      expect(calls(d, 'cover_width_set').at(-1)).toEqual({ path: 'Rex.md', width: 356 }),
    );
    // Double-click resets to the default.
    fireEvent.doubleClick(edge);
    await waitFor(() =>
      expect(calls(d, 'cover_width_set').at(-1)).toEqual({ path: 'Rex.md', width: null }),
    );
    expect(strip()!.style.getPropertyValue('--cover-width')).toBe('280px');
    expect(d.writes()).toEqual([]);
  });

  it("a right strip's edge is on its left: ← widens it", async () => {
    sides = { 'Rex.md': 'right' };
    await openWithCover({ 'Rex.md': COVER }, 'Rex.md');
    const edge = screen.getByRole('separator', { name: 'Cover width' });
    edge.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(edge).toHaveAttribute('aria-valuenow', '296');
  });

  it('a side cover repositions in both axes; Save writes cover-x and cover-y', async () => {
    sides = { 'Rex.md': 'left' };
    const d = await openWithCover(
      { 'Rex.md': '---\ncover: sky.png\ncover-y: 40\ncover-x: 20\n---\n# Rex\n' },
      'Rex.md',
    );
    const img = document.querySelector<HTMLImageElement>('img[data-cover]')!;
    expect(img.style.objectPosition).toBe('20% 40%');
    await userEvent.click(screen.getByRole('button', { name: 'Reposition' }));
    const slider = screen.getByRole('slider', { name: 'Cover position' });
    expect(slider).toHaveFocus();
    expect(slider).toHaveAttribute('aria-valuetext', '20% from the left, 40% from the top');
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowDown}');
    expect(img.style.objectPosition).toBe('30% 35%');
    await userEvent.click(screen.getByRole('button', { name: 'Save position' }));
    await waitFor(() =>
      expect(d.files.get('Rex.md')).toBe(
        '---\ncover: sky.png\ncover-y: 35\ncover-x: 30\n---\n# Rex\n',
      ),
    );
  });

  it('a top cover keeps vertical-only reposition but shows the stored horizontal focus', async () => {
    await openWithCover({ 'Rex.md': '---\ncover: sky.png\ncover-x: 70\n---\n# Rex\n' }, 'Rex.md');
    const img = document.querySelector<HTMLImageElement>('img[data-cover]')!;
    expect(img.style.objectPosition).toBe('70% 50%');
    await userEvent.click(screen.getByRole('button', { name: 'Reposition' }));
    await userEvent.keyboard('{ArrowLeft}{ArrowRight}');
    expect(img.style.objectPosition).toBe('70% 50%');
  });

  it('a window too narrow for the strip shows the cover on top, without saving anything', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    sides = { 'Rex.md': 'left' };
    const d = await openWithCover({ 'Rex.md': COVER }, 'Rex.md');
    act(() => observed.forEach((report) => report(1200)));
    expect(strip()).not.toBeNull();
    // 280 px strip + 520 px of text don't fit in 700 px.
    act(() => observed.forEach((report) => report(700)));
    await waitFor(() => expect(strip()).toBeNull());
    expect(band().dataset.band).toBe('cover');
    // The choice is still Left: widening brings the strip back.
    expect(within(placement()).getByRole('radio', { name: 'Cover on the left' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    act(() => observed.forEach((report) => report(900)));
    await waitFor(() => expect(strip()).not.toBeNull());
    expect(calls(d, 'cover_side_set')).toEqual([]);
  });

  // Final review I1: the edge used to go to 45% of the window whatever room
  // the page had, so widening past the room flipped the strip to the top
  // band mid-drag, losing the drag (and keyboard focus) without saving.
  it("the strip's edge stops where the text would go below its minimum: the strip stays and the width saves", async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    sides = { 'Rex.md': 'left' };
    const d = await openWithCover({ 'Rex.md': COVER }, 'Rex.md');
    // The sidebar is open: the page area is 900 px, so 900 − 520 = 380 px
    // is the most the strip can take (less than 45% of 1024 px, 460).
    act(() => observed.forEach((report) => report(900)));
    const edge = screen.getByRole('separator', { name: 'Cover width' });
    expect(edge).toHaveAttribute('aria-valuemax', '380');
    const at = (type: string, x: number) =>
      act(() => {
        edge.dispatchEvent(
          new PointerEvent(type, { bubbles: true, clientX: x, clientY: 300, pointerId: 1 }),
        );
      });
    await at('pointerdown', 500);
    await at('pointermove', 700);
    expect(strip()).not.toBeNull();
    expect(edge).toHaveAttribute('aria-valuenow', '380');
    await at('pointerup', 700);
    await waitFor(() =>
      expect(calls(d, 'cover_width_set')).toEqual([{ path: 'Rex.md', width: 380 }]),
    );
    expect(strip()).not.toBeNull();
    // End goes to the same limit; the strip and the edge's focus stay.
    await act(() => useCoverLayoutStore.getState().saveWidth('Rex.md', null));
    edge.focus();
    await userEvent.keyboard('{End}');
    expect(strip()).not.toBeNull();
    expect(edge).toHaveFocus();
    expect(edge).toHaveAttribute('aria-valuenow', '380');
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(calls(d, 'cover_width_set').at(-1)).toEqual({ path: 'Rex.md', width: 380 }),
    );
  });

  it('a window narrowed mid-drag drops the drag: the strip comes back at its saved width', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    sides = { 'Rex.md': 'left' };
    const d = await openWithCover({ 'Rex.md': COVER }, 'Rex.md');
    act(() => observed.forEach((report) => report(1200)));
    const edge = screen.getByRole('separator', { name: 'Cover width' });
    act(() => {
      edge.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientX: 500,
          clientY: 300,
          pointerId: 1,
        }),
      );
      edge.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          clientX: 560,
          clientY: 300,
          pointerId: 1,
        }),
      );
    });
    // 600 px can't hold even the narrowest strip (160) beside 520 px of text.
    act(() => observed.forEach((report) => report(600)));
    await waitFor(() => expect(strip()).toBeNull());
    act(() => observed.forEach((report) => report(1200)));
    await waitFor(() => expect(strip()).not.toBeNull());
    expect(screen.getByRole('separator', { name: 'Cover width' })).toHaveAttribute(
      'aria-valuenow',
      '280',
    );
    expect(calls(d, 'cover_width_set')).toEqual([]);
  });

  it('⌘Z in the editor puts the previous placement back', async () => {
    const d = await openWithCover({ 'Rex.md': COVER }, 'Rex.md');
    await userEvent.click(within(placement()).getByRole('radio', { name: 'Cover on the right' }));
    await waitFor(() => expect(strip()?.dataset.coverStrip).toBe('right'));
    await userEvent.click(document.querySelector<HTMLElement>('.cm-content')!);
    await userEvent.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(strip()).toBeNull());
    expect(calls(d, 'cover_side_set').map((a) => (a as { side: string }).side)).toEqual([
      'right',
      'top',
    ]);
    await userEvent.keyboard('{Control>}y{/Control}');
    await waitFor(() => expect(strip()?.dataset.coverStrip).toBe('right'));
  });

  it('has no axe violations with a side cover', async () => {
    sides = { 'Rex.md': 'left' };
    await openWithCover({ 'Rex.md': COVER }, 'Rex.md');
    const res = await axe.run(document.body);
    expect(res.violations).toEqual([]);
  });
});
