import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { usePageStore } from '../../stores/pageStore';
import { useUiStore } from '../../stores/uiStore';
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

describe('links to files outside the vault (M4b part 3 §9)', () => {
  const outsideAt = (path: string, exists = true) =>
    mockIPC((cmd, raw) => {
      const n = ((raw as { targets?: unknown[] })?.targets ?? []).length;
      if (cmd === 'links_resolve') return Array(n).fill(null);
      if (cmd === 'links_external') {
        return Array(n).fill({
          path,
          exists,
          listed: true,
          network: false,
          askFirst: false,
          openable: true,
        });
      }
      return null;
    });

  it('[[D:\\…]] asks to open the file, never to create a page', async () => {
    useUiStore.setState({ dialog: null });
    outsideAt('D:\\Docs\\x.pdf');
    const v = editor('Read [[D:\\Docs\\x.pdf]] now\n', 8);
    expect(followLinkAtCursor(v)).toBe(true);
    await vi.waitFor(() =>
      expect(useUiStore.getState().dialog).toEqual({
        type: 'openFile',
        path: 'D:\\Docs\\x.pdf',
        external: true,
      }),
    );
  });

  it('a Markdown link with a file: URL or a drive path is followed too', async () => {
    useUiStore.setState({ dialog: null });
    outsideAt('/Users/j/a b.pdf');
    const v = editor('[a](file:///Users/j/a%20b.pdf) [b](D:\\x.pdf)\n', 2);
    expect(followLinkAtCursor(v)).toBe(true);
    await vi.waitFor(() =>
      expect(useUiStore.getState().dialog).toEqual({
        type: 'openFile',
        path: '/Users/j/a b.pdf',
        external: true,
      }),
    );
    useUiStore.setState({ dialog: null });
    act(() => v.dispatch({ selection: { anchor: 33 } }));
    expect(followLinkAtCursor(v)).toBe(true);
    await vi.waitFor(() => expect(useUiStore.getState().dialog?.type).toBe('openFile'));
  });

  it('final review I1: [[/Projects/New idea]] with nothing on disk offers Create page', async () => {
    useUiStore.setState({ dialog: null });
    mockIPC((cmd, raw) => {
      const n = ((raw as { targets?: unknown[] })?.targets ?? []).length;
      if (cmd === 'links_resolve' || cmd === 'links_external') return Array(n).fill(null);
      return null;
    });
    const v = editor('See [[/Projects/New idea]] now\n', 8);
    expect(followLinkAtCursor(v)).toBe(true);
    await vi.waitFor(() =>
      expect(useUiStore.getState().dialog).toMatchObject({
        type: 'createPage',
        target: '/Projects/New idea',
      }),
    );
  });

  it('final review C1: a link to a network file asks before anything loads it', async () => {
    useUiStore.setState({ dialog: null });
    const unc = '\\\\nas\\share\\x.pdf';
    mockIPC((cmd, raw) => {
      const n = ((raw as { targets?: unknown[] })?.targets ?? []).length;
      if (cmd === 'links_resolve') return Array(n).fill(null);
      if (cmd === 'links_external') {
        return Array(n).fill({
          path: unc,
          exists: false,
          listed: true,
          network: true,
          askFirst: true,
          openable: true,
        });
      }
      return null;
    });
    const v = editor(`Read [[${unc}]] now\n`, 8);
    expect(followLinkAtCursor(v)).toBe(true);
    await vi.waitFor(() =>
      expect(useUiStore.getState().dialog).toEqual({
        type: 'openFile',
        path: unc,
        external: true,
        network: true,
      }),
    );
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

describe('Live Preview maths (M4b part 2 §3)', () => {
  it('inline maths renders unless the cursor is on its line; $$ blocks render as widgets', async () => {
    const text = 'Intro $x^2$ end.\n\n$$\na+b\n$$\n\nAfter\n';
    const v = editor(text, text.length - 1);
    await vi.waitFor(() => expect(v.contentDOM.querySelectorAll('.katex').length).toBe(2));
    await moveTo(v, 7);
    await vi.waitFor(() => expect(line(v, 1)).toBe('Intro $x^2$ end.'));
  });
});

describe('Live Preview diagrams (M4b part 2 §4)', () => {
  it('a mermaid fence off the cursor is a block widget without a code badge', async () => {
    const text = 'x\n\n```mermaid\ngraph TD; A-->B\n```\n\nend\n';
    const v = editor(text, text.length - 1);
    expect(v.contentDOM.querySelector('.cm-nimw-widget')).not.toBeNull();
    expect(v.contentDOM.querySelector('.cm-nimw-codebadge')).toBeNull();
  });
});

describe('wide elements (M4b part 3): what may escape the measure', () => {
  const kinds = (v: EditorView) =>
    [...v.contentDOM.querySelectorAll<HTMLElement>('.cm-nimw-widget')].map(
      (w) => w.dataset.wideKind ?? null,
    );

  it('block widgets say their kind: tables, maths, diagrams and lone images; others none', () => {
    const text =
      'Top\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n$$\nx^2\n$$\n\n' +
      '```mermaid\nflowchart LR\n  A --> B\n```\n\n![[pic.png]]\n\n![[Other]]\n\n> [!note]\n> Callout\n';
    const v = editor(text);
    expect(kinds(v)).toEqual(['tables', 'maths', 'diagrams', 'images', null, null]);
  });

  it("code lines carry their block's widest line; raw table lines do while edited", async () => {
    const text =
      'Top\n\n```js\nshort();\n\tconst longer = 1;\n```\n\n| a | b |\n| - | - |\n| one | two |\n';
    const v = editor(text);
    const code = [...v.contentDOM.querySelectorAll<HTMLElement>('.cm-nimw-codeblock')];
    expect(code).toHaveLength(4);
    // The tab counts as four columns: "    const longer = 1;" is 21.
    expect(code.map((l) => l.style.getPropertyValue('--nimw-ch'))).toEqual([
      '21',
      '21',
      '21',
      '21',
    ]);
    expect(code.map((l) => l.dataset.wideSrc)).toEqual(['code', 'code', 'code', 'code']);
    expect(v.contentDOM.querySelector('[data-wide-src="tables"]')).toBeNull();
    await moveTo(v, v.state.doc.line(9).from);
    const rows = [...v.contentDOM.querySelectorAll<HTMLElement>('[data-wide-src="tables"]')];
    expect(rows.map((l) => l.textContent)).toEqual(['| a | b |', '| - | - |', '| one | two |']);
    expect(rows[0].style.getPropertyValue('--nimw-ch')).toBe('13');
  });

  it('a Mermaid block being edited follows the diagrams choice', async () => {
    const text = 'Top\n\n```mermaid\nflowchart LR\n```\n';
    const v = editor(text);
    await moveTo(v, v.state.doc.line(4).from);
    const src = [...v.contentDOM.querySelectorAll<HTMLElement>('.cm-nimw-codeblock')];
    expect(src.map((l) => l.dataset.wideSrc)).toEqual(['diagrams', 'diagrams', 'diagrams']);
  });
});

describe('Live Preview renders the whole page (round 3 §1)', () => {
  const codeLines = (v: EditorView) => [
    ...v.contentDOM.querySelectorAll<HTMLElement>('.cm-line.cm-nimw-codeblock'),
  ];

  it('a fenced block hides its fences off the cursor: a header row with the language and Copy', async () => {
    const text = 'Top\n\n```js\nconst a = 1;\n```\n\nEnd\n';
    const v = editor(text, text.length - 1);
    expect(v.contentDOM.textContent).not.toContain('```');
    const rows = codeLines(v);
    expect(rows).toHaveLength(3);
    expect(rows[0].querySelector('.cm-nimw-codebadge')).not.toBeNull();
    expect(rows[1]).toHaveTextContent('const a = 1;');
    expect(rows[2].textContent).toBe('');
    // Clicking into it shows the source in the same lines: nothing below moves.
    await moveTo(v, v.state.doc.line(4).from);
    expect(codeLines(v).map((l) => l.textContent)).toEqual(['```js', 'const a = 1;', '```']);
    expect(v.contentDOM.querySelector('.cm-nimw-codebadge')).toBeNull();
  });

  it('~~~ fences follow the same rule; an unclosed fence keeps its last line', () => {
    const v = editor('x\n\n~~~\nplain\n~~~\n\n```py\nlast line', 0);
    expect(v.contentDOM.textContent).not.toContain('~~~');
    expect(line(v, 4)).toBe('plain');
    // The unclosed block's opening fence is the header row too.
    expect(line(v, 7)).not.toContain('```');
    expect(v.contentDOM.querySelectorAll('.cm-nimw-codebadge')).toHaveLength(2);
    expect(line(v, 8)).toBe('last line');
  });

  /** What the block's Copy button puts on the clipboard. */
  const copied = async (v: EditorView) => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    act(() => v.contentDOM.querySelector<HTMLElement>('.cm-nimw-codebadge-copy')!.click());
    return (writeText.mock.calls[0] as unknown as [string])[0];
  };

  it('a closing fence needs the opening character and length; text that only looks like one stays', async () => {
    let v = editor('x\n\n````md\n```js\ncode\n```', 0);
    expect(line(v, 6)).toBe('```');
    expect(await copied(v)).toBe('```js\ncode\n```');
    v.destroy();
    v = editor('x\n\n```\nabc\n~~~', 0);
    expect(line(v, 5)).toBe('~~~');
    expect(await copied(v)).toBe('abc\n~~~');
  });

  it('code inside a quote keeps its own > characters; its fences render like any other', async () => {
    const v = editor('x\n\n> ```\n> > a > b\n> >>> 1\n> ```\n', 0);
    expect(line(v, 4)).toBe('> a > b');
    expect(line(v, 5)).toBe('>>> 1');
    expect(v.contentDOM.textContent).not.toContain('```');
    expect(await copied(v)).toBe('> a > b\n>>> 1');
  });

  it('a fence on a list item renders like any other', () => {
    const v = editor('x\n\n- ```js\n  a\n  ```\n', 0);
    expect(v.contentDOM.textContent).not.toContain('```');
    expect(v.contentDOM.querySelector('.cm-nimw-codebadge')).not.toBeNull();
  });

  it('a task inside a quote keeps a working checkbox', () => {
    const v = editor('x\n\n> - [ ] todo\n', 0);
    expect(v.contentDOM.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(line(v, 3)).toBe(' todo');
  });

  it('bullets render as a bullet, numbers stay styled; the cursor line shows its marker', async () => {
    const v = editor('x\n\n- one\n  - two\n\n1. first\n', 0);
    expect(line(v, 3)).toBe('• one');
    expect(line(v, 4)).toBe('  • two');
    expect(line(v, 6)).toBe('1. first');
    expect(v.contentDOM.querySelector('.cm-nimw-listnum')).toHaveTextContent('1.');
    await moveTo(v, v.state.doc.line(3).from);
    expect(line(v, 3)).toBe('- one');
    expect(line(v, 4)).toBe('  • two');
  });

  it("a task's marker hides off the cursor; only its checkbox shows", () => {
    const v = editor('- [ ] todo\n\nother\n', 13);
    expect(line(v, 1)).toBe(' todo');
    expect(v.contentDOM.querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  it('quotes hide their > markers, nested ones too, until the cursor enters', async () => {
    const v = editor('x\n\n> one\n> \n> > deep\n\nend\n', 0);
    expect([line(v, 3), line(v, 4), line(v, 5)]).toEqual(['one', '', 'deep']);
    expect(v.contentDOM.querySelectorAll('.cm-nimw-quote').length).toBeGreaterThan(0);
    await moveTo(v, v.state.doc.line(4).from);
    expect([line(v, 3), line(v, 4), line(v, 5)]).toEqual(['> one', '> ', '> > deep']);
  });
});
