import { EditorView } from '@codemirror/view';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import i18next from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { movableBlocks } from '../../markdown/blockModel';
import { parsePage } from '../../markdown/parse';
import { useToastStore } from '../../stores/toastStore';
import { fakeDisk } from '../../test/fakeDisk';
import { anchorsOf, movedMessage } from './BlockGutter';
import { Editor } from './Editor';
import { PageDoc } from './pageDoc';

const hooks = { onChange: () => undefined, onConflictCopy: () => undefined };
const viewOf = (): EditorView =>
  EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
const source = () => viewOf().state.doc.toString();

/** The page in Split mode, once the pane shows it. */
async function split(text: string) {
  return (await splitView(text)).pane;
}
/** The same, with what it takes to show something else in the editor. */
async function splitView(text: string, others: Record<string, string> = {}) {
  fakeDisk({ 'B.md': text, ...others });
  const res = await PageDoc.load('B.md', hooks);
  if (!res.ok) throw new Error(res.error.message);
  const shown = render(<Editor doc={res.value} mode="split" label="B" />);
  const pane = await screen.findByRole('region', { name: 'Preview' });
  await vi.waitFor(() => expect(pane.querySelector('[data-source-start]')).not.toBeNull());
  return { pane, doc: res.value, rerender: shown.rerender };
}
/** The rendered block whose text is `text` (deepest match). */
const block = (pane: HTMLElement, text: string) =>
  [...pane.querySelectorAll<HTMLElement>('[data-source-start]')]
    .reverse()
    .find((el) => el.textContent?.trim().startsWith(text))!;
const hover = (el: Element) => act(() => fireEvent.mouseOver(el));
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  act(() => fireEvent.keyDown(el, { key: k, ...init }));
/** Shows a gutter's buttons (they open when it's hovered). */
const opened = (name: string) => {
  const group = screen.getByRole('group', { name });
  fireEvent.mouseEnter(group);
  return group;
};
const grip = (name: string) => screen.getByRole('button', { name: `Drag to reorder: ${name}` });
const status = () => document.querySelector('[data-block-status]')!.textContent;

afterEach(() => clearMocks());

describe('the block gutter in the Split pane (M4 §4)', () => {
  it('hovering a block shows its gutter: the deepest block only; a list shows its own from its margin', async () => {
    const pane = await split('P1\n\nP2\n\n- a\n  - a1\n');
    await hover(block(pane, 'P2'));
    const group = opened('P2');
    expect(within(group).getByRole('button', { name: 'Drag to reorder: P2' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Move up' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Move down' })).toBeInTheDocument();
    await hover(block(pane, 'a1'));
    const item = opened('a1');
    expect(within(item).getByRole('button', { name: 'Outdent' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'a' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'List: a' })).not.toBeInTheDocument();
    // The list itself, outside any of its items (its left margin).
    await hover(pane.querySelector('ul')!);
    expect(screen.getByRole('group', { name: 'List: a' })).toBeInTheDocument();
  });

  it('a hovered block keeps its gutter while the pointer crosses the margin to it', async () => {
    const pane = await split('P1\n\nP2\n');
    await hover(block(pane, 'P2'));
    expect(screen.getByRole('group', { name: 'P2' })).toBeInTheDocument();
    // Between the block and its gutter (the pane's padding), or between blocks.
    await hover(pane);
    await hover(pane.querySelector('[data-source-start]')!.parentElement!);
    expect(screen.getByRole('group', { name: 'P2' })).toBeInTheDocument();
    // Another block takes it; leaving the pane hides it.
    await hover(block(pane, 'P1'));
    expect(screen.queryByRole('group', { name: 'P2' })).not.toBeInTheDocument();
    await hover(block(pane, 'P2'));
    act(() => fireEvent.mouseLeave(pane));
    expect(screen.queryByRole('group', { name: 'P2' })).not.toBeInTheDocument();
  });

  it('Move up moves the block in the source and says so', async () => {
    const pane = await split('P1\n\nP2\n');
    await hover(block(pane, 'P2'));
    const up = within(opened('P2')).getByRole('button', { name: 'Move up' });
    await act(() => up.click());
    expect(source()).toBe('P2\n\nP1\n');
    expect(status()).toBe('Moved P2 to the top of the page.');
  });

  it('Indent and Outdent move a list item between levels', async () => {
    const pane = await split('- a\n- b\n');
    await hover(block(pane, 'b'));
    const indent = within(opened('b')).getByRole('button', { name: 'Indent' });
    await act(() => indent.click());
    expect(source()).toBe('- a\n  - b\n');
    expect(status()).toBe('Moved b into a.');
  });

  it('final review M5: the live region says where the block went', async () => {
    let pane = await split('P1\n\nP2\n\nP3\n');
    await hover(block(pane, 'P1'));
    const down = within(opened('P1')).getByRole('button', { name: 'Move down' });
    await act(() => down.click());
    expect(source()).toBe('P2\n\nP1\n\nP3\n');
    expect(status()).toBe('Moved P1 after P2.');
    cleanup();
    pane = await split('- a\n- b\n\n| h |\n|---|\n| 1 |\n| 2 |\n');
    await hover(block(pane, 'b'));
    const up = within(opened('b')).getByRole('button', { name: 'Move up' });
    await act(() => up.click());
    expect(status()).toBe('Moved b before a.');
    await wait(50);
    await hover(block(pane, '1'));
    const rowDown = within(opened('1')).getByRole('button', { name: 'Move down' });
    await act(() => rowDown.click());
    expect(source()).toBe('- b\n- a\n\n| h |\n|---|\n| 2 |\n| 1 |\n');
    expect(status()).toBe('Moved 1 after 2.');
  });

  it('keyboard: one tab stop, ↑/↓ go from block to block, Alt+↑ moves it and its grip keeps the keyboard', async () => {
    await split('P1\n\nP2\n\nP3\n');
    const first = grip('P1');
    expect(first.tabIndex).toBe(0);
    act(() => first.focus());
    await key(first, 'ArrowDown');
    expect(grip('P2')).toHaveFocus();
    await key(grip('P2'), 'ArrowUp', { altKey: true });
    expect(source()).toBe('P2\n\nP1\n\nP3\n');
    await vi.waitFor(() => expect(grip('P2')).toHaveFocus());
    expect(status()).toBe('Moved P2 to the top of the page.');
  });

  it('after a move the pane shows it at once; a key while the pane lags the editor does nothing', async () => {
    const pane = await split('P1\n\nP2\n\nP3\n');
    act(() => grip('P1').focus());
    await key(grip('P1'), 'ArrowDown');
    await key(grip('P2'), 'ArrowUp', { altKey: true });
    // Well within the 150 ms render delay for typing.
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(pane.querySelector('[data-source-start]')!.textContent).toBe('P2');
    await vi.waitFor(() => expect(grip('P2')).toHaveFocus());
    // Typing reaches the pane only after its delay: meanwhile a gutter key
    // would act on blocks that have changed, so it does nothing.
    act(() => viewOf().dispatch({ changes: { from: viewOf().state.doc.length, insert: 'x' } }));
    await key(grip('P2'), 'ArrowDown', { altKey: true });
    await key(grip('P2'), 'Enter');
    expect(source()).toBe('P2\n\nP1\n\nP3\nx');
    expect(status()).toBe('Moved P2 to the top of the page.');
  });

  it('Enter picks a block up: arrows choose a place, Enter drops it; Escape cancels', async () => {
    await split('P1\n\nP2\n\nP3\n');
    act(() => grip('P1').focus());
    await key(grip('P1'), 'Enter');
    expect(status()).toBe(
      'P1 picked up. Arrow keys choose where, Enter drops it, Escape cancels. Before P3',
    );
    await key(grip('P1'), 'ArrowDown');
    expect(status()).toBe('At the end of the page');
    await key(grip('P1'), 'Escape');
    expect(status()).toBe('Move cancelled.');
    expect(source()).toBe('P1\n\nP2\n\nP3\n');
    await key(grip('P1'), 'Enter');
    await key(grip('P1'), 'ArrowDown');
    await key(grip('P1'), 'Enter');
    expect(source()).toBe('P2\n\nP3\n\nP1\n');
  });

  it('review focus: blocks of an embedded note get no gutter; the embed itself does', async () => {
    // The embedded note's paragraph starts at offset 12, like this page's P2:
    // its offsets must never be taken for the page's.
    fakeDisk({
      'B.md': '![[Other]]\n\nP2\n',
      'Other.md': '# Other no\n\nInside the other note.\n',
    });
    const res = await PageDoc.load('B.md', hooks);
    if (!res.ok) throw new Error(res.error.message);
    render(<Editor doc={res.value} mode="split" label="B" />);
    const pane = await screen.findByRole('region', { name: 'Preview' });
    const inner = await within(pane).findByText('Inside the other note.');
    // The gutter maps blocks again once the embed has loaded (any change).
    act(() => viewOf().dispatch({ changes: { from: viewOf().state.doc.length, insert: '\n' } }));
    await act(() => new Promise((r) => setTimeout(r, 200)));
    await hover(inner);
    expect(screen.queryByRole('group', { name: 'Inside the other note.' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'P2' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Other' })).toBeInTheDocument();
  });

  it('final review I1: an HTML block gets its gutter from the element it renders; a <details> still holds the Markdown after it', async () => {
    const pane = await split('<details>\n<summary>More</summary>\n\nHidden\n\n</details>\n\nP2\n');
    expect(pane.querySelector('details > p')?.textContent).toBe('Hidden');
    expect(pane.querySelector('[data-nimw="html"]')).toBeNull();
    await hover(pane.querySelector('summary')!);
    expect(screen.getByRole('group', { name: 'HTML block' })).toBeInTheDocument();
    await hover(block(pane, 'Hidden'));
    expect(screen.getByRole('group', { name: 'Hidden' })).toBeInTheDocument();
  });

  it('review focus: a move the guard refuses changes nothing and says why', async () => {
    const pane = await split('- a\n\nPara\n\n- b\n');
    await hover(block(pane, 'Para'));
    const down = within(opened('Para')).getByRole('button', { name: 'Move down' });
    await act(() => down.click());
    expect(source()).toBe('- a\n\nPara\n\n- b\n');
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('This block can’t be moved here.');
  });

  it('NFR-10: no axe violations with a gutter showing', async () => {
    const pane = await split('# T\n\nP1\n\n- a\n- b\n');
    await hover(block(pane, 'b'));
    const violations = await axe
      .run(pane, { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
  });
});

/** jsdom has no layout: blocks 20 px tall, 30 px apart, items 24 px in. */
function layout(pane: HTMLElement) {
  pane.getBoundingClientRect = () => new DOMRect(0, 0, 600, 400);
  let y = 0;
  for (const el of pane.querySelectorAll<HTMLElement>('[data-source-start]')) {
    if (el.tagName === 'P' && el.closest('li')) continue;
    const top = y;
    const left = el.tagName === 'LI' ? 40 : 16;
    el.getBoundingClientRect = () => new DOMRect(left, top, 500, 20);
    y += 30;
  }
}
const pointer = (
  target: EventTarget,
  type: string,
  x: number,
  y: number,
  init: PointerEventInit = {},
) =>
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        // The primary button is down until it's released.
        buttons: type === 'pointerup' ? 0 : 1,
        ...init,
      }),
    );
  });

describe('dragging a block (M4 §4)', () => {
  it('acceptance: drag P3 above P1, and the source follows', async () => {
    const pane = await split('P1\n\nP2\n\nP3\n');
    layout(pane);
    await hover(block(pane, 'P3'));
    const g = grip('P3');
    await pointer(g, 'pointerdown', 4, 61);
    await pointer(window, 'pointermove', 4, 30);
    await pointer(window, 'pointermove', 4, 2);
    expect(document.querySelector('[data-drop-line]')).not.toBeNull();
    await pointer(window, 'pointerup', 4, 2);
    expect(source()).toBe('P3\n\nP1\n\nP2\n');
    expect(status()).toBe('Moved P3 to the top of the page.');
    expect(document.querySelector('[data-drop-line]')).toBeNull();
  });

  it('Escape cancels a drag; a click without a drag moves nothing', async () => {
    const pane = await split('P1\n\nP2\n\nP3\n');
    layout(pane);
    await hover(block(pane, 'P3'));
    await pointer(grip('P3'), 'pointerdown', 4, 61);
    await pointer(window, 'pointermove', 4, 2);
    await act(() => fireEvent.keyDown(window, { key: 'Escape' }));
    expect(document.querySelector('[data-drop-line]')).toBeNull();
    await pointer(window, 'pointerup', 4, 2);
    expect(source()).toBe('P1\n\nP2\n\nP3\n');
    expect(status()).toBe('Move cancelled.');
    await pointer(grip('P3'), 'pointerdown', 4, 61);
    await pointer(window, 'pointerup', 5, 62);
    expect(source()).toBe('P1\n\nP2\n\nP3\n');
  });

  it('a list item goes to the level under the pointer', async () => {
    const pane = await split('- a\n- b\n- c\n');
    layout(pane);
    await hover(block(pane, 'c'));
    await pointer(grip('c'), 'pointerdown', 20, 91);
    // Just under `a`, right of its text column: nested under it.
    await pointer(window, 'pointermove', 70, 52);
    await pointer(window, 'pointerup', 70, 52);
    expect(source()).toBe('- a\n  - c\n- b\n');
  });

  it('dragging near the bottom edge scrolls the pane', async () => {
    const pane = await split('P1\n\nP2\n\nP3\n');
    layout(pane);
    let top = 0;
    Object.defineProperty(pane, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => (top = v),
    });
    await hover(block(pane, 'P1'));
    await pointer(grip('P1'), 'pointerdown', 4, 1);
    await pointer(window, 'pointermove', 4, 395);
    await vi.waitFor(() => expect(top).toBeGreaterThan(20));
    await pointer(window, 'pointerup', 4, 395);
  });

  it('Alt held at the drop moves a heading without its section', async () => {
    const pane = await split('# A\n\npa\n\n# B\n\npb\n');
    layout(pane);
    await hover(block(pane, 'A'));
    await pointer(grip('A'), 'pointerdown', 4, 1);
    await pointer(window, 'pointermove', 4, 115, { altKey: true });
    await pointer(window, 'pointerup', 4, 115, { altKey: true });
    expect(source()).toBe('pa\n\n# B\n\npb\n\n# A\n');
  });
});

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
const lastToast = () => {
  const toasts = useToastStore.getState().toasts;
  return toasts.length ? toasts[toasts.length - 1].message : null;
};
const CHANGED = 'That block changed, so it wasn’t moved. Try again.';

describe('a drag ends with its pointer (final review M2)', () => {
  it('blocks removed while one is hovered: the gutter keeps working', async () => {
    const pane = await split('P1\n\nP2\n\nP3\n');
    await hover(block(pane, 'P3'));
    expect(screen.getByRole('group', { name: 'P3' })).toBeInTheDocument();
    act(() => viewOf().dispatch({ changes: { from: 0, to: 8 } }));
    await wait(200);
    expect(pane.querySelector('[data-source-start]')!.textContent).toBe('P3');
    await hover(block(pane, 'P3'));
    expect(screen.getByRole('group', { name: 'P3' })).toBeInTheDocument();
  });

  /** P3 picked up and held above P1, with the drop line showing. */
  async function holding() {
    const view = await splitView('P1\n\nP2\n\nP3\n', { 'O.md': 'Other\n\nP3\n' });
    layout(view.pane);
    await hover(block(view.pane, 'P3'));
    const g = grip('P3');
    await pointer(g, 'pointerdown', 4, 61);
    await pointer(window, 'pointermove', 4, 2);
    expect(document.querySelector('[data-drop-line]')).not.toBeNull();
    return { ...view, grip: g };
  }
  const cancelled = async () => {
    expect(document.querySelector('[data-drop-line]')).toBeNull();
    expect(status()).toBe('Move cancelled.');
    // The release that follows drops nothing.
    await pointer(window, 'pointerup', 4, 2);
    expect(source()).toBe('P1\n\nP2\n\nP3\n');
  };

  it('the browser taking the pointer (pointercancel) cancels it', async () => {
    await holding();
    await pointer(window, 'pointercancel', 4, 2);
    await cancelled();
  });

  it('losing the pointer capture without a release cancels it', async () => {
    const { grip: g } = await holding();
    await act(() => g.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true })));
    await cancelled();
  });

  it('a release that never arrived: the next move with no button down cancels it', async () => {
    await holding();
    await pointer(window, 'pointermove', 4, 30, { buttons: 0 });
    await cancelled();
  });

  it('a release that never arrived: the next press anywhere cancels it, and its click drops nothing', async () => {
    await holding();
    await pointer(document.body, 'pointerdown', 4, 2);
    await cancelled();
  });

  it('the window losing focus cancels it', async () => {
    await holding();
    await act(() => window.dispatchEvent(new FocusEvent('blur')));
    await cancelled();
  });

  it('leaving Split mid-drag removes its listeners', async () => {
    const { pane, doc, rerender } = await splitView('P1\n\nP2\n\nP3\n');
    layout(pane);
    await hover(block(pane, 'P3'));
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    await pointer(grip('P3'), 'pointerdown', 4, 61);
    await pointer(window, 'pointermove', 4, 2);
    const drag = added.mock.calls.map(([type, fn]) => [type, fn]);
    expect(drag.map(([type]) => type)).toContain('pointerup');
    rerender(<Editor doc={doc} mode="source" label="B" />);
    const gone = removed.mock.calls.map(([type, fn]) => [type, fn]);
    for (const [type, fn] of drag) {
      expect(
        gone.some(([t, f]) => t === type && f === fn),
        String(type),
      ).toBe(true);
    }
    added.mockRestore();
    removed.mockRestore();
  });

  it('another page shown mid-drag: the drop moves nothing there', async () => {
    const { rerender } = await holding();
    const other = await PageDoc.load('O.md', hooks);
    if (!other.ok) throw new Error(other.error.message);
    rerender(<Editor doc={other.value} mode="split" label="O" />);
    await wait(200);
    await pointer(window, 'pointermove', 4, 2);
    await pointer(window, 'pointerup', 4, 2);
    expect(source()).toBe('Other\n\nP3\n');
  });

  it('Escape cancels it without reaching anything else', async () => {
    await holding();
    const elsewhere = vi.fn();
    document.addEventListener('keydown', elsewhere);
    await act(() => fireEvent.keyDown(document.body, { key: 'Escape' }));
    document.removeEventListener('keydown', elsewhere);
    expect(elsewhere).not.toHaveBeenCalled();
    await cancelled();
  });
});

describe('the block moved is the block picked (final review C2)', () => {
  it('text that changes during a drag: the dragged block is found again in the new text and moves', async () => {
    const pane = await split('P1\n\nP2\n\nP3\n');
    layout(pane);
    await hover(block(pane, 'P3'));
    await pointer(grip('P3'), 'pointerdown', 4, 61);
    await pointer(window, 'pointermove', 4, 30);
    // Meanwhile a paragraph arrives at the top (typing, a reload, a merge),
    // and the pane shows it.
    act(() => viewOf().dispatch({ changes: { from: 0, insert: 'New\n\n' } }));
    await wait(200);
    layout(pane);
    // Above P1, which is now the second block.
    await pointer(window, 'pointermove', 4, 32);
    await pointer(window, 'pointerup', 4, 32);
    expect(source()).toBe('New\n\nP3\n\nP1\n\nP2\n');
  });

  it('a dragged block that was edited meanwhile stays put, and the drop says why', async () => {
    const pane = await split('P1\n\nP2\n\nP3\n');
    layout(pane);
    await hover(block(pane, 'P3'));
    await pointer(grip('P3'), 'pointerdown', 4, 61);
    await pointer(window, 'pointermove', 4, 2);
    act(() => viewOf().dispatch({ changes: { from: 10, insert: 'x' } }));
    await pointer(window, 'pointerup', 4, 2);
    expect(source()).toBe('P1\n\nP2\n\nP3x\n');
    expect(status()).toBe('Move cancelled.');
    expect(lastToast()).toBe(CHANGED);
  });

  it('a pane that lags the editor: Move up finds its block in the current text', async () => {
    const pane = await split('P1\n\nP2\n');
    await hover(block(pane, 'P2'));
    const up = within(opened('P2')).getByRole('button', { name: 'Move up' });
    act(() => viewOf().dispatch({ changes: { from: 0, insert: 'New\n\n' } }));
    await act(() => up.click());
    expect(source()).toBe('New\n\nP2\n\nP1\n');
  });

  it('typing next to a --- rule, then a pick-up: the quote moves, not a list item', async () => {
    const pane = await split('Intro\n\n---\n\nPara\n\n- a\n- b\n\n> q\n\nEnd\n');
    act(() => viewOf().dispatch({ changes: { from: 16, insert: 'X' } }));
    await wait(200);
    await hover(block(pane, 'q'));
    act(() => grip('q').focus());
    await key(grip('q'), 'Enter');
    for (let k = 0; k < 10; k++) await key(grip('q'), 'ArrowUp');
    expect(status()).toBe('Before Intro');
    await key(grip('q'), 'Enter');
    expect(source()).toBe('> q\n\nIntro\n\n---\n\nParaX\n\n- a\n- b\n\nEnd\n');
  });
});

describe('mapping blocks to the pane (final review I2)', () => {
  it('maps a large note’s blocks in linear time: typing in Split doesn’t stall', () => {
    // ~3,000 rendered blocks, like a 200 KB note: matching each block against
    // every element took seconds here (and ~300 ms a render in WebKit).
    const text = `${Array.from({ length: 3000 }, (_, i) => `Paragraph ${i}.`).join('\n\n')}\n`;
    const model = movableBlocks(text, parsePage(text));
    const pane = document.createElement('div');
    pane.innerHTML = model.units
      .map((u) => `<p data-source-start="${u.from}" data-source-end="${u.to}">x</p>`)
      .join('');
    const t0 = performance.now();
    const anchors = anchorsOf(pane, model, text);
    const ms = performance.now() - t0;
    expect(anchors.size).toBe(3000);
    expect(anchors.get(2999)?.dataset.sourceStart).toBe(String(model.units[2999].from));
    expect(ms).toBeLessThan(250);
  });

  it('a block’s anchor is the outermost element of its kind starting on its first line', () => {
    const text = '- a\n  - b\n\n> q\n';
    const model = movableBlocks(text, parsePage(text));
    const pane = document.createElement('div');
    pane.innerHTML =
      '<ul data-source-start="0"><li data-source-start="0"><p data-source-start="2">a</p>' +
      '<ul data-source-start="6"><li data-source-start="6">b</li></ul></li></ul>' +
      '<section data-note-embed=""><p data-source-start="11">other note</p></section>' +
      '<blockquote data-source-start="11"><p data-source-start="13">q</p></blockquote>';
    const tags = [...anchorsOf(pane, model, text)].map(([id, el]) => [
      model.units[id].kind,
      el.tagName,
    ]);
    expect(tags).toEqual([
      ['list', 'UL'],
      ['listItem', 'LI'],
      ['listItem', 'LI'],
      ['quote', 'BLOCKQUOTE'],
    ]);
  });
});

describe('the live region after a move (final review M5)', () => {
  const after = (text: string) => ({ text, model: movableBlocks(text, parsePage(text)) });
  const paragraph = movableBlocks('x\n', parsePage('x\n')).units[0];

  it('names the block and where it went, in English and Spanish; names are taken as written', async () => {
    const note = after('P2\n\nDon’t {stop} it\n\nP3\n');
    const t = i18next.t.bind(i18next);
    expect(movedMessage(note, 4, paragraph, t)).toBe('Moved Don’t {stop} it after P2.');
    expect(movedMessage(note, 0, paragraph, t)).toBe('Moved P2 to the top of the page.');
    await i18next.changeLanguage('es');
    expect(movedMessage(note, 4, paragraph, t)).toBe('Se movió Don’t {stop} it después de P2.');
    expect(movedMessage(note, 0, paragraph, t)).toBe('Se movió P2 al principio de la página.');
    const list = after('- a\n  - b\n- c\n');
    const item = list.model.units[2];
    expect(movedMessage(list, 4, item, t)).toBe('Se movió b dentro de a.');
    expect(movedMessage(list, 0, item, t)).toBe('Se movió a antes de c.');
  });
});
