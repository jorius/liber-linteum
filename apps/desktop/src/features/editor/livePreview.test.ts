import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { usePageStore } from '../../stores/pageStore';
import {
  followLinkAtCursor,
  LARGE_NOTE_CHARS,
  livePreview,
  pagePath,
  REPARSE_MS,
} from './livePreview';

let view: EditorView | null = null;

/** Creates the editor inside act(): block widgets render with React. */
function editor(doc: string, cursor = 0): EditorView {
  act(() => {
    view = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      state: EditorState.create({
        doc,
        selection: EditorSelection.cursor(cursor),
        extensions: [livePreview(), pagePath.of(() => 'Notes/Page.md')],
      }),
    });
  });
  return view!;
}

/** Visible text of line `n` (1-based), as rendered. */
const line = (v: EditorView, n: number) =>
  (v.contentDOM.querySelectorAll('.cm-line')[n - 1] as HTMLElement | undefined)?.textContent;

const moveTo = (v: EditorView, pos: number) =>
  act(() => v.dispatch({ selection: { anchor: pos } }));

afterEach(() => {
  view?.destroy();
  view = null;
  vi.useRealTimers();
  clearMocks();
  document.body.innerHTML = '';
});

describe('Live Preview (M2a §3.2)', () => {
  it('hides markup except on lines touched by the selection', async () => {
    const v = editor('# Title\n\n**bold** and [[Sparda|alias]] and [md](x.md) `code`\n');
    expect(line(v, 1)).toBe('# Title');
    expect(line(v, 3)).toBe('bold and alias and md code');
    await moveTo(v, v.state.doc.line(3).from);
    expect(line(v, 1)).toBe('Title');
    expect(line(v, 3)).toBe('**bold** and [[Sparda|alias]] and [md](x.md) `code`');
  });

  it('shows the alias of the table form [[a\\|b]] like the parser does', () => {
    const v = editor('x\n\n[[Sparda\\|alias]] and [[A#H]]\n');
    expect(line(v, 3)).toBe('alias and A#H');
  });

  it('styles headings by level and inline formatting by kind', () => {
    const v = editor('x\n\n## Two\n\n*em* ==hi== ~~no~~ #tag\n');
    expect(v.contentDOM.querySelector('.cm-nimw-h2')).toHaveTextContent('Two');
    expect(v.contentDOM.querySelector('.cm-nimw-em')).toHaveTextContent('em');
    expect(v.contentDOM.querySelector('.cm-nimw-highlight')).toHaveTextContent('hi');
    expect(v.contentDOM.querySelector('.cm-nimw-strike')).toHaveTextContent('no');
    expect(v.contentDOM.querySelector('.cm-nimw-tag')).toHaveTextContent('#tag');
  });

  it('review focus: positions are UTF-16 offsets, so astral characters keep markup aligned', () => {
    const v = editor('x\n\n😀 **b** [[X|y]] 中文 ==m== 👩‍👩‍👧 *e*\n');
    expect(line(v, 3)).toBe('😀 b y 中文 m 👩‍👩‍👧 e');
  });

  it('task checkboxes are clickable and toggle the source', async () => {
    const v = editor('- [ ] todo\n\nother\n', 13);
    const box = v.contentDOM.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.checked).toBe(false);
    await act(() => box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(v.state.doc.line(1).text).toBe('- [x] todo');
  });

  it('the checkbox stays on its line while the cursor is there (feedback 2026-10-13)', async () => {
    const v = editor('- [ ] todo\n\nother\n', 8);
    const box = v.contentDOM.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(box).not.toBeNull();
    await act(() => box!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(v.state.doc.line(1).text).toBe('- [x] todo');
  });

  it('tables, callouts and rules become rendered widgets until the cursor enters them', async () => {
    const doc = 'x\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> [!tip] Hint\n> body\n\n---\n';
    const v = editor(doc);
    expect(v.contentDOM.querySelectorAll('.cm-nimw-widget')).toHaveLength(3);
    expect(v.contentDOM.querySelector('.cm-nimw-widget table')).not.toBeNull();
    await moveTo(v, doc.indexOf('| 1'));
    expect(v.contentDOM.querySelectorAll('.cm-nimw-widget')).toHaveLength(2);
    expect(v.contentDOM.textContent).toContain('| 1 | 2 |');
  });

  it('re-parses after typing (debounced) and hides the new markup', async () => {
    vi.useFakeTimers();
    const v = editor('x\n\nend\n', 0);
    act(() => v.dispatch({ changes: { from: 1, insert: ' **new**' } }));
    await moveTo(v, v.state.doc.length);
    await act(() => vi.advanceTimersByTimeAsync(REPARSE_MS));
    expect(line(v, 1)).toBe('x new');
  });

  // Parses a real 200 KB note: seconds when the whole suite runs in parallel.
  it('large notes get the reduced set: headings, emphasis and links only', () => {
    // Realistic: short paragraphs (one giant paragraph is a much slower, separate case).
    const para = 'plain text line one\nplain text line two\n\n';
    const filler = para.repeat(Math.ceil(LARGE_NOTE_CHARS / para.length) + 10);
    const v = editor(`x\n\n# Big\n\n- [ ] task **b**\n\n| a |\n|---|\n| 1 |\n\n${filler}`);
    expect(v.contentDOM.querySelector('.cm-nimw-h1')).not.toBeNull();
    expect(v.contentDOM.querySelector('.cm-nimw-widget')).toBeNull();
    expect(v.contentDOM.querySelector('input[type="checkbox"]')).toBeNull();
    expect(line(v, 5)).toBe('- [ ] task b');
  }, 30_000);

  it('Mod-Enter follows the link under the cursor (keyboard ⌘-click)', async () => {
    mockIPC((cmd) => {
      if (cmd === 'links_resolve') return ['Notes/Sparda.md'];
      if (cmd === 'page_get') throw { kind: 'notFound', message: 'x' };
      if (cmd === 'page_read') return { text: '', hash: 'h' };
      return null;
    });
    const v = editor('See [[Sparda#Weapons]] now\n', 8);
    expect(followLinkAtCursor(v)).toBe(true);
    await vi.waitFor(() => expect(usePageStore.getState().path).toBe('Notes/Sparda.md'));
    expect(usePageStore.getState().anchor?.heading).toBe('Weapons');
    await moveTo(v, 1);
    expect(followLinkAtCursor(v)).toBe(false);
  });

  describe('a plain click on a link (as in Obsidian)', () => {
    const resolveTo = () =>
      mockIPC((cmd) => {
        if (cmd === 'links_resolve') return ['Notes/Sparda.md'];
        if (cmd === 'page_get') throw { kind: 'notFound', message: 'x' };
        if (cmd === 'page_read') return { text: '', hash: 'h' };
        return null;
      });
    const click = (v: EditorView, init: MouseEventInit = {}) => {
      const link = v.contentDOM.querySelector('.cm-nimw-link')!;
      act(() => {
        link.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init }),
        );
      });
    };
    const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

    it('follows a rendered link', async () => {
      resolveTo();
      usePageStore.setState({ path: null });
      const v = editor('x\n\nSee [[Sparda|the twins]] now\n', 0);
      click(v);
      await vi.waitFor(() => expect(usePageStore.getState().path).toBe('Notes/Sparda.md'));
    });

    it('edits a link on the cursor line (it shows its source)', async () => {
      resolveTo();
      usePageStore.setState({ path: null });
      const v = editor('x\n\nSee [[Sparda|the twins]] now\n', 0);
      await moveTo(v, v.state.doc.line(3).from);
      click(v);
      await settle();
      expect(usePageStore.getState().path).toBeNull();
    });

    it('shift-click extends the selection instead', async () => {
      resolveTo();
      usePageStore.setState({ path: null });
      const v = editor('x\n\nSee [[Sparda]] now\n', 0);
      click(v, { shiftKey: true });
      await settle();
      expect(usePageStore.getState().path).toBeNull();
    });
  });

  it('a link target with a bare % is followed as written, never throws (I4)', async () => {
    const asked: unknown[] = [];
    mockIPC((cmd, args) => {
      if (cmd !== 'links_resolve') return null;
      asked.push(args);
      return ['Notes/B.md'];
    });
    const v = editor('[a](#100%) and [b](B.md#50%)\n', 2);
    expect(followLinkAtCursor(v)).toBe(true);
    expect(usePageStore.getState().anchor?.heading).toBe('100%');
    act(() => v.dispatch({ selection: { anchor: 18 } }));
    expect(() => followLinkAtCursor(v)).not.toThrow();
    await vi.waitFor(() => expect(asked).toHaveLength(1));
  });
});

describe('raw HTML blocks (M2c §7.7)', () => {
  it('render sanitized like a table; the cursor on them shows the source', async () => {
    const v = editor(
      'x\n\n<div align="center">\n<b>Hi</b> <script>alert(1)</script>\n</div>\n\npara\n',
      0,
    );
    const widget = v.contentDOM.querySelector('.cm-nimw-widget')!;
    expect(widget).not.toBeNull();
    expect(widget.querySelector('b')).toHaveTextContent('Hi');
    expect(widget.querySelector('script')).toBeNull();
    expect(v.contentDOM.textContent).not.toContain('<div');
    await moveTo(v, v.state.doc.line(3).from);
    expect(v.contentDOM.querySelector('.cm-nimw-widget')).toBeNull();
    expect(line(v, 3)).toBe('<div align="center">');
  });

  it('comments and blocks that sanitize to nothing keep their source, muted', () => {
    const v = editor('x\n\n<!-- a note -->\n\n<script>alert(1)</script>\n\npara\n', 0);
    expect(v.contentDOM.querySelector('.cm-nimw-widget')).toBeNull();
    expect(line(v, 3)).toBe('<!-- a note -->');
    expect(v.contentDOM.querySelectorAll('.cm-line')[2]).toHaveClass('cm-nimw-muted');
    expect(line(v, 5)).toBe('<script>alert(1)</script>');
    expect(v.contentDOM.querySelectorAll('.cm-line')[4]).toHaveClass('cm-nimw-muted');
  });

  it('inline HTML inside a paragraph stays text', () => {
    const v = editor('x\n\na <b>bold</b> c\n', 0);
    expect(v.contentDOM.querySelector('.cm-nimw-widget')).toBeNull();
    expect(line(v, 3)).toBe('a <b>bold</b> c');
  });
});
