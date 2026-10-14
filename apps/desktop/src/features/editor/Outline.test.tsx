import { EditorView } from '@codemirror/view';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { fakeDisk } from '../../test/fakeDisk';
import { Editor } from './Editor';
import { OUTLINE_DEBOUNCE_MS } from './Outline';
import { PageDoc } from './pageDoc';

const hooks = { onChange: () => undefined, onConflictCopy: () => undefined };
const viewOf = (): EditorView =>
  EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;

const TEXT = '# One\n\nIntro.\n\n## Two\n\nBody.\n\n### Three\n\nMore.\n\n# Four\n\nEnd.\n';

async function open(text = TEXT, mode: 'livePreview' | 'split' = 'livePreview') {
  fakeDisk({ 'A.md': text });
  const res = await PageDoc.load('A.md', hooks);
  if (!res.ok) throw new Error(res.error.message);
  render(<Editor doc={res.value} mode={mode} label="A" />);
  return screen.getByRole('tree', { name: 'Outline' });
}

beforeEach(() => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, outline: true } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearMocks();
});

describe('outline panel (M4b part 2 §5)', () => {
  it('lists the headings as a tree, indented by level, and only when it is on', async () => {
    const tree = await open();
    const items = within(tree).getAllByRole('treeitem');
    expect(
      items.map((i) => [i.textContent?.replace(/[▾▸]/, ''), i.getAttribute('aria-level')]),
    ).toEqual([
      ['One', '1'],
      ['Two', '2'],
      ['Three', '3'],
      ['Four', '1'],
    ]);
    expect(items[0]).toHaveAttribute('aria-expanded', 'true');
    expect(items[3]).not.toHaveAttribute('aria-expanded');
    act(() => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, outline: false } }));
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
  });

  it('click and Enter put the cursor at the heading and the keyboard in the editor', async () => {
    const tree = await open();
    await userEvent.click(within(tree).getByRole('treeitem', { name: /Three/ }));
    const view = viewOf();
    expect(view.state.selection.main.head).toBe(TEXT.indexOf('Three'));
    expect(view.hasFocus).toBe(true);
    within(tree).getByRole('treeitem', { name: /Four/ }).focus();
    await userEvent.keyboard('{Enter}');
    expect(view.state.selection.main.head).toBe(TEXT.indexOf('Four'));
  });

  it('marks the heading holding the cursor', async () => {
    const tree = await open();
    act(() => viewOf().dispatch({ selection: { anchor: TEXT.indexOf('Body') } }));
    expect(within(tree).getByRole('treeitem', { name: /Two/ })).toHaveAttribute(
      'aria-current',
      'location',
    );
    act(() => viewOf().dispatch({ selection: { anchor: 0 } }));
    expect(within(tree).getByRole('treeitem', { name: /One/ })).toHaveAttribute(
      'aria-current',
      'location',
    );
  });

  it('↑/↓ move, ← folds and goes to the parent, → unfolds and goes to the child', async () => {
    const tree = await open();
    const item = (name: RegExp) => within(tree).queryByRole('treeitem', { name });
    item(/One/)!.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(item(/Two/)).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(item(/Two/)).toHaveAttribute('aria-expanded', 'false');
    expect(item(/Three/)).toBeNull();
    await userEvent.keyboard('{ArrowLeft}');
    expect(item(/One/)).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{ArrowRight}');
    expect(item(/Three/)).not.toBeNull();
    await userEvent.keyboard('{ArrowRight}');
    expect(item(/Three/)).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(item(/Four/)).toHaveFocus();
    // One tab stop.
    expect(tree.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it('follows typing after a pause', async () => {
    vi.useFakeTimers();
    const tree = await open('# One\n');
    act(() => viewOf().dispatch({ changes: { from: 6, insert: '\n## New' } }));
    expect(within(tree).queryByRole('treeitem', { name: /New/ })).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(OUTLINE_DEBOUNCE_MS));
    expect(within(tree).getByRole('treeitem', { name: /New/ })).toBeInTheDocument();
  });

  it('says when there are no headings', async () => {
    fakeDisk({ 'A.md': 'Just text.\n' });
    const res = await PageDoc.load('A.md', hooks);
    if (!res.ok) throw new Error();
    render(<Editor doc={res.value} mode="livePreview" label="A" />);
    expect(screen.getByText('No headings yet.')).toBeInTheDocument();
  });

  it('is resizable from 200 to 420 px, by keyboard too', async () => {
    await open();
    const edge = screen.getByRole('separator', { name: 'Outline width' });
    expect(edge).toHaveAttribute('aria-valuenow', '260');
    edge.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(edge).toHaveAttribute('aria-valuenow', '276');
    for (let i = 0; i < 20; i++) await userEvent.keyboard('{ArrowLeft}');
    expect(edge).toHaveAttribute('aria-valuenow', '420');
    expect(screen.getByRole('complementary', { name: 'Outline' }).style.width).toBe('420px');
  });

  it('overlays the editor in a narrow window, where Escape closes it', async () => {
    mockIPC((cmd, raw) =>
      cmd === 'settings_set'
        ? { ...useSettingsStore.getState().settings, ...(raw as { patch: object }).patch }
        : null,
    );
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('max-width'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const tree = await open();
    expect(screen.getByRole('complementary', { name: 'Outline' })).toHaveAttribute(
      'data-overlay',
      'true',
    );
    within(tree).getAllByRole('treeitem')[0].focus();
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.queryByRole('tree')).not.toBeInTheDocument());
    expect(viewOf().hasFocus).toBe(true);
  });

  it('NFR-10: no axe violations', async () => {
    await open();
    const panel = screen.getByRole('complementary', { name: 'Outline' });
    const violations = await axe
      .run(panel, { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
  });
});
