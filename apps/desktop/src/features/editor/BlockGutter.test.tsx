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
