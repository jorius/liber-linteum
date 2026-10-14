import { EditorView } from '@codemirror/view';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { fakeDisk } from '../../test/fakeDisk';
import { Editor } from './Editor';
import { PageDoc } from './pageDoc';

const hooks = { onChange: () => undefined, onConflictCopy: () => undefined };
const viewOf = (): EditorView =>
  EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
const source = () => viewOf().state.doc.toString();

/** The page in Split mode, once the pane shows it. */
async function split(text: string) {
  fakeDisk({ 'B.md': text });
  const res = await PageDoc.load('B.md', hooks);
  if (!res.ok) throw new Error(res.error.message);
  render(<Editor doc={res.value} mode="split" label="B" />);
  const pane = await screen.findByRole('region', { name: 'Preview' });
  await vi.waitFor(() => expect(pane.querySelector('[data-source-start]')).not.toBeNull());
  return pane;
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

  it('Move up moves the block in the source and says so', async () => {
    const pane = await split('P1\n\nP2\n');
    await hover(block(pane, 'P2'));
    const up = within(opened('P2')).getByRole('button', { name: 'Move up' });
    await act(() => up.click());
    expect(source()).toBe('P2\n\nP1\n');
    expect(status()).toBe('Moved P2.');
  });

  it('Indent and Outdent move a list item between levels', async () => {
    const pane = await split('- a\n- b\n');
    await hover(block(pane, 'b'));
    const indent = within(opened('b')).getByRole('button', { name: 'Indent' });
    await act(() => indent.click());
    expect(source()).toBe('- a\n  - b\n');
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
    expect(status()).toBe('Moved P2.');
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
    expect(status()).toBe('Moved P3.');
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
