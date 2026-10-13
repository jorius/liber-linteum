import { undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { fakeDisk, type FakeDisk } from '../../test/fakeDisk';
import { Editor } from './Editor';
import { AUTOSAVE_MS, PageDoc } from './pageDoc';

const hooks = { onChange: () => undefined, onConflictCopy: () => undefined };

async function load(path: string) {
  const res = await PageDoc.load(path, hooks);
  if (!res.ok) throw new Error(res.error.message);
  return res.value;
}

const viewOf = (): EditorView =>
  EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;

/** Types `text` at `at` (default: the cursor), as a user would. */
const type = (text: string, at?: number) =>
  act(() => {
    const v = viewOf();
    const from = at ?? v.state.selection.main.head;
    v.dispatch({
      changes: { from, insert: text },
      selection: { anchor: from + text.length },
      userEvent: 'input.type',
    });
  });

let disk: FakeDisk;

afterEach(() => {
  vi.useRealTimers();
  clearMocks();
});

describe('Editor (M2a §3.2–3.3)', () => {
  it('ED-07: switching modes keeps the text, the selection and the undo history', async () => {
    disk = fakeDisk({ 'A.md': '# A\n\nbody\n' });
    const doc = await load('A.md');
    const { rerender } = render(<Editor doc={doc} mode="livePreview" label="A" />);
    const view = viewOf();
    await type('!', 3);
    rerender(<Editor doc={doc} mode="source" label="A" />);
    expect(viewOf()).toBe(view);
    expect(view.state.doc.toString()).toBe('# A!\n\nbody\n');
    expect(view.state.selection.main.head).toBe(4);
    expect(view.dom).toHaveClass('cm-nimw-source');
    rerender(<Editor doc={doc} mode="split" label="A" />);
    expect(screen.getByRole('region', { name: 'Preview' })).toHaveTextContent('A!');
    act(() => void undo(view));
    expect(view.state.doc.toString()).toBe('# A\n\nbody\n');
  });

  it('typing reaches the page document, which autosaves', async () => {
    disk = fakeDisk({ 'A.md': 'one\n' });
    const doc = await load('A.md');
    vi.useFakeTimers();
    render(<Editor doc={doc} mode="source" label="A" />);
    await type('two ', 0);
    expect(doc.text).toBe('two one\n');
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_MS));
    expect(disk.files.get('A.md')).toBe('two one\n');
  });

  it('leaving the editor (blur) saves at once, without waiting for the debounce', async () => {
    disk = fakeDisk({ 'A.md': 'one\n' });
    const doc = await load('A.md');
    vi.useFakeTimers();
    render(<Editor doc={doc} mode="source" label="A" />);
    await type('two ', 0);
    await act(async () => {
      viewOf().contentDOM.dispatchEvent(new FocusEvent('blur'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(disk.files.get('A.md')).toBe('two one\n');
  });

  it('review focus: undo after an external merge undoes only my edit', async () => {
    disk = fakeDisk({ 'A.md': 'one\ntwo\nthree\nfour\n' });
    const doc = await load('A.md');
    render(<Editor doc={doc} mode="source" label="A" />);
    await type('!', 3);
    disk.files.set('A.md', 'one\ntwo\nthree\nFOUR\n');
    await act(() => doc.sync());
    const view = viewOf();
    expect(view.state.doc.toString()).toBe('one!\ntwo\nthree\nFOUR\n');
    act(() => void undo(view));
    expect(view.state.doc.toString()).toBe('one\ntwo\nthree\nFOUR\n');
  });

  it('an external reload keeps the cursor on the same text', async () => {
    disk = fakeDisk({ 'A.md': 'one\ntwo\n' });
    const doc = await load('A.md');
    render(<Editor doc={doc} mode="source" label="A" />);
    act(() => viewOf().dispatch({ selection: { anchor: 6 } })); // in "two"
    disk.files.set('A.md', 'zero\none\ntwo\n');
    await act(() => doc.sync());
    expect(viewOf().state.selection.main.head).toBe(11);
  });

  it('each page keeps its own undo history; a background change shows on return', async () => {
    disk = fakeDisk({ 'A.md': 'aaa\n', 'B.md': 'bbb\n' });
    const a = await load('A.md');
    const b = await load('B.md');
    const { rerender } = render(<Editor doc={a} mode="source" label="A" />);
    await type('1', 0);
    rerender(<Editor doc={b} mode="source" label="B" />);
    expect(viewOf().state.doc.toString()).toBe('bbb\n');
    await type('2', 0);
    await act(() => a.flush());
    disk.files.set('A.md', '1aaa\nmore\n');
    await act(() => a.sync()); // A is not shown: no editor attached
    rerender(<Editor doc={a} mode="source" label="A" />);
    const view = viewOf();
    expect(view.state.doc.toString()).toBe('1aaa\nmore\n');
    act(() => void undo(view));
    expect(view.state.doc.toString()).toBe('aaa\nmore\n');
    expect(b.text).toBe('2bbb\n');
  });
});
