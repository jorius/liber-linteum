import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { history, undo } from '@codemirror/commands';
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  activeFormats,
  editorKeymap,
  insertDivider,
  insertLink,
  listIndent,
  setHeading,
  toggleBlock,
  toggleInline,
} from './format';

/** `‹…›` marks a selection, `¦` a cursor (several allowed). */
function stateOf(marked: string): EditorState {
  const ranges: { anchor: number; head: number }[] = [];
  let doc = '';
  let start = -1;
  for (const ch of marked) {
    if (ch === '‹') start = doc.length;
    else if (ch === '›') ranges.push({ anchor: start, head: doc.length });
    else if (ch === '¦') ranges.push({ anchor: doc.length, head: doc.length });
    else doc += ch;
  }
  return EditorState.create({
    doc,
    selection: EditorSelection.create(
      ranges.map((r) => EditorSelection.range(r.anchor, r.head)),
      0,
    ),
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      history(),
      markdown({ base: markdownLanguage }),
    ],
  });
}

function marked(state: EditorState): string {
  let out = state.doc.toString();
  const ranges = [...state.selection.ranges].sort((a, b) => b.from - a.from);
  for (const r of ranges) {
    out = r.empty
      ? `${out.slice(0, r.from)}¦${out.slice(r.from)}`
      : `${out.slice(0, r.from)}‹${out.slice(r.from, r.to)}›${out.slice(r.to)}`;
  }
  return out;
}

function run(cmd: StateCommand, input: string | EditorState): EditorState {
  let state = typeof input === 'string' ? stateOf(input) : input;
  const handled = cmd({ state, dispatch: (tr) => (state = tr.state) });
  expect(handled).toBe(true);
  return state;
}

const apply = (cmd: StateCommand, input: string) => marked(run(cmd, input));

describe('inline formats (M2b §6)', () => {
  it('wraps a selection and unwraps it again', () => {
    expect(apply(toggleInline('bold'), 'hello ‹world›')).toBe('hello **‹world›**');
    expect(apply(toggleInline('bold'), 'hello **‹world›**')).toBe('hello ‹world›');
    expect(apply(toggleInline('bold'), 'hello ‹**world**›')).toBe('hello ‹world›');
    expect(apply(toggleInline('strike'), '‹gone›')).toBe('~~‹gone›~~');
    expect(apply(toggleInline('highlight'), '‹mark›')).toBe('==‹mark›==');
    expect(apply(toggleInline('code'), '‹x = 1›')).toBe('`‹x = 1›`');
  });

  it('an empty cursor formats the word under it, or opens an empty pair', () => {
    expect(apply(toggleInline('bold'), 'hel¦lo there')).toBe('**hel¦lo** there');
    expect(apply(toggleInline('bold'), '**hel¦lo** there')).toBe('hel¦lo there');
    expect(apply(toggleInline('italic'), 'a ¦ b')).toBe('a *¦* b');
  });

  it('italic inside bold adds italic instead of breaking the bold', () => {
    expect(apply(toggleInline('italic'), '**wo¦rd**')).toBe('***wo¦rd***');
    expect(apply(toggleInline('italic'), '***wo¦rd***')).toBe('**wo¦rd**');
  });

  it('every selection at once, in one undo step', () => {
    const s = run(toggleInline('bold'), '‹one› and ‹two›');
    expect(marked(s)).toBe('**‹one›** and **‹two›**');
    let back = s;
    undo({ state: s, dispatch: (tr) => (back = tr.state) });
    expect(back.doc.toString()).toBe('one and two');
  });
});

describe('block formats', () => {
  it('headings set, replace and clear the # prefix of every selected line', () => {
    expect(apply(setHeading(2), 'Title¦')).toBe('## Title¦');
    expect(apply(setHeading(3), '# A¦')).toBe('### A¦');
    expect(apply(setHeading(0), '## A¦')).toBe('A¦');
    expect(apply(setHeading(1), '‹a\nb›')).toBe('‹# a\n# b›');
  });

  it('lists toggle their prefix, switch kinds and keep indentation', () => {
    expect(apply(toggleBlock('bullet'), '‹a\nb›')).toBe('‹- a\n- b›');
    expect(apply(toggleBlock('bullet'), '‹- a\n- b›')).toBe('‹a\nb›');
    expect(apply(toggleBlock('numbered'), '‹a\n\nb›')).toBe('‹1. a\n\n2. b›');
    expect(apply(toggleBlock('task'), '- a¦')).toBe('- [ ] a¦');
    expect(apply(toggleBlock('numbered'), '  - a¦')).toBe('  1. a¦');
    expect(apply(toggleBlock('bullet'), '¦')).toBe('- ¦');
  });

  it('a selection ending at a line start (triple-click) leaves the next line alone', () => {
    expect(apply(toggleBlock('bullet'), '‹first\n›second')).toBe('‹- first\n›second');
    expect(apply(setHeading(1), '‹first\n›second')).toBe('‹# first\n›second');
    expect(apply(toggleBlock('quote'), '‹first\n›second')).toBe('‹> first\n›second');
    expect(apply(toggleBlock('task'), '‹first\n›second')).toBe('‹- [ ] first\n›second');
    expect(apply(toggleBlock('numbered'), '‹first\n›second')).toBe('‹1. first\n›second');
    // Toggling off counts only the selected line too.
    expect(apply(toggleBlock('bullet'), '‹- first\n›second')).toBe('‹first\n›second');
  });

  it('quote adds and removes "> " in front of every line', () => {
    expect(apply(toggleBlock('quote'), '‹a\n- b›')).toBe('‹> a\n> - b›');
    expect(apply(toggleBlock('quote'), '‹> a\n> - b›')).toBe('‹a\n- b›');
  });

  it('a divider never turns the paragraph above into a heading', () => {
    expect(apply(insertDivider, 'text¦')).toBe('text\n\n---\n¦');
    expect(apply(insertDivider, 'text\n¦')).toBe('text\n\n---\n¦');
    expect(apply(insertDivider, '¦')).toBe('---\n¦');
  });

  it('a link wraps the selection and selects the address to type', () => {
    expect(apply(insertLink, 'see ‹site›')).toBe('see [site](‹url›)');
    expect(apply(insertLink, 'see ¦')).toBe('see [¦]()');
  });
});

describe('keys', () => {
  it('⌘[ / ⌘] belong to back/forward, not to indentation', () => {
    const keys = editorKeymap.map((b) => b.key);
    expect(keys).not.toContain('Mod-[');
    expect(keys).not.toContain('Mod-]');
    for (const k of ['Mod-b', 'Mod-i', 'Mod-Shift-x', 'Mod-Shift-h', 'Mod-e', 'Mod-k']) {
      expect(keys, k).toContain(k);
    }
    for (const n of [0, 1, 2, 3, 4, 5, 6]) expect(keys).toContain(`Mod-Alt-${n}`);
    for (const k of ['Mod-Shift-7', 'Mod-Shift-8', 'Mod-Shift-9', 'Mod-Shift-.']) {
      expect(keys).toContain(k);
    }
  });

  it('Tab indents only inside a list item; elsewhere it moves focus', () => {
    expect(apply(listIndent(1), '- a\n- b¦')).toBe('- a\n  - b¦');
    expect(apply(listIndent(-1), '- a\n  - b¦')).toBe('- a\n- b¦');
    const plain = stateOf('text¦');
    expect(listIndent(1)({ state: plain, dispatch: () => undefined })).toBe(false);
  });
});

describe('activeFormats (toolbar pressed state)', () => {
  const at = (input: string) => {
    const s = stateOf(input);
    ensureSyntaxTree(s, s.doc.length, 1000);
    return activeFormats(s);
  };
  it('reads the syntax tree at the cursor', () => {
    expect(at('**bo¦ld** and *it*')).toEqual(new Set(['bold']));
    expect(at('***bo¦th***')).toEqual(new Set(['bold', 'italic']));
    expect(at('~~ga¦ne~~ `co`')).toEqual(new Set(['strike']));
    expect(at('`co¦de`')).toEqual(new Set(['code']));
    expect(at('## He¦ad')).toEqual(new Set(['h2']));
    expect(at('- [ ] ta¦sk')).toEqual(new Set(['task']));
    expect(at('1. on¦e')).toEqual(new Set(['numbered']));
    expect(at('> - qu¦ote')).toEqual(new Set(['quote', 'bullet']));
    expect(at('a ==hi¦gh== b')).toEqual(new Set(['highlight']));
    expect(at('pla¦in')).toEqual(new Set());
  });
});
