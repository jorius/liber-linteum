import { acceptCompletion, CompletionContext, startCompletion } from '@codemirror/autocomplete';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import type { LinkSuggestion } from '../../ipc';
import { headingLinkText, sameHeading } from '../../markdown/headings';
import { linkCompletion, linkQueryAt, linkSource } from './linkComplete';
import { pagePath } from './livePreview';

const REX: LinkSuggestion = {
  path: 'Character Design/rex-draft.md',
  kind: 'page',
  title: 'Generator Rex',
  target: 'rex-draft',
};
const COVER: LinkSuggestion = {
  path: 'Character Design/assets/rex-cover.png',
  kind: 'attachment',
  title: null,
  target: 'rex-cover.png',
};

let view: EditorView | null = null;

function editor(doc: string, pos = doc.length): EditorView {
  view = new EditorView({
    parent: document.body.appendChild(document.createElement('div')),
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(pos),
      extensions: [linkCompletion(), pagePath.of(() => 'Notes/Page.md')],
    }),
  });
  return view;
}

/** Runs the source at the cursor and applies option `i`. */
async function complete(v: EditorView, i = 0) {
  const ctx = new CompletionContext(v.state, v.state.selection.main.head, false);
  const result = await linkSource(ctx);
  if (!result) return null;
  const option = result.options[i];
  if (option && typeof option.apply === 'function') {
    option.apply(v, option, result.from, result.to ?? v.state.selection.main.head);
  }
  return result;
}

afterEach(() => {
  view?.destroy();
  view = null;
  clearMocks();
  document.body.innerHTML = '';
});

describe('linkQueryAt (M2c §6)', () => {
  const at = (doc: string, pos = doc.length) => linkQueryAt(EditorState.create({ doc }), pos);

  it('finds [[ / ![[ queries, # heading queries and an existing ]]', () => {
    expect(at('See [[gen')).toEqual({
      kind: 'file',
      embed: false,
      query: 'gen',
      from: 6,
      closed: false,
    });
    expect(at('![[rex')).toMatchObject({ kind: 'file', embed: true, query: 'rex', from: 3 });
    expect(at('[[Sparda#Pal')).toEqual({
      kind: 'heading',
      embed: false,
      page: 'Sparda',
      query: 'Pal',
      from: 9,
      closed: false,
    });
    expect(at('[[gen]] x', 5)).toMatchObject({ query: 'gen', closed: true });
  });

  it('ignores aliases, closed links and single brackets', () => {
    expect(at('[[a|b')).toBeNull();
    expect(at('[[a]] b')).toBeNull();
    expect(at('text [x')).toBeNull();
    expect(at('[[a\nb')).toBeNull();
  });
});

describe('linkSource (M2c §6, PG-05)', () => {
  it('PG-05: picking "Generator Rex" inserts [[rex-draft|Generator Rex]]', async () => {
    const asked: unknown[] = [];
    mockIPC((cmd, args) => {
      if (cmd === 'link_suggest') {
        asked.push(args);
        return [REX];
      }
    });
    const v = editor('See [[gen');
    const result = await complete(v);
    expect(asked).toEqual([{ source: 'Notes/Page.md', query: 'gen', embed: false }]);
    expect(result!.options[0]).toMatchObject({ label: 'Generator Rex', detail: REX.path });
    expect(v.state.doc.toString()).toBe('See [[rex-draft|Generator Rex]]');
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
  });

  it('keeps an existing ]] and moves past it; no alias when the title is the name', async () => {
    mockIPC(() => [{ ...REX, title: 'Rex-Draft' }]);
    const v = editor('See [[gen]] x', 9);
    await complete(v);
    expect(v.state.doc.toString()).toBe('See [[rex-draft]] x');
    expect(v.state.selection.main.head).toBe('See [[rex-draft]]'.length);
  });

  it('![[ embeds: attachments keep their extension, pages get no alias', async () => {
    const asked: unknown[] = [];
    mockIPC((_cmd, args) => {
      asked.push(args);
      return [COVER, REX];
    });
    const v = editor('![[rex');
    const result = await complete(v);
    expect(asked).toEqual([{ source: 'Notes/Page.md', query: 'rex', embed: true }]);
    expect(result!.options[0]).toMatchObject({ label: 'rex-cover.png' });
    expect(v.state.doc.toString()).toBe('![[rex-cover.png]]');
    const w = editor('![[rex');
    await complete(w, 1);
    expect(w.state.doc.toString()).toBe('![[rex-draft]]');
  });

  it('[[# lists the current page headings; the inserted text still scrolls there', async () => {
    mockIPC(() => null);
    const v = editor('# Intro\n## Ideas [draft]\n### C# tips\nSee [[#i');
    const result = await complete(v);
    expect(result!.options.map((o) => o.label)).toEqual(['Intro', 'Ideas [draft]', 'C# tips']);
    expect(v.state.doc.toString().endsWith('See [[#Intro]]')).toBe(true);
    // The link-safe text still finds its heading (Split scroll, section embeds).
    for (const h of ['Ideas [draft]', 'C# tips', 'Pipes | and ^carets']) {
      expect(sameHeading(h, headingLinkText(h))).toBe(true);
    }
    expect(headingLinkText('Ideas [draft]')).toBe('Ideas draft');
    expect(headingLinkText('Pipes | and ^carets')).toBe('Pipes and carets');
  });

  it('[[Page#… lists that page headings, filtered by the text after #', async () => {
    const calls: string[] = [];
    mockIPC((cmd) => {
      calls.push(cmd);
      if (cmd === 'links_resolve') return ['Notes/Sparda.md'];
      if (cmd === 'page_read') return { text: '# Sparda\n## Palette\n## Weapons\n', hash: 'h' };
    });
    const v = editor('[[Sparda#pal');
    const result = await complete(v);
    expect(result!.options.map((o) => o.label)).toEqual(['Palette']);
    expect(v.state.doc.toString()).toBe('[[Sparda#Palette]]');
    expect(calls).toEqual(['links_resolve', 'page_read']);
  });

  it('an unresolved page has no headings to offer', async () => {
    mockIPC((cmd) => (cmd === 'links_resolve' ? [null] : null));
    const v = editor('[[Nope#');
    const result = await complete(v);
    expect(result?.options ?? []).toEqual([]);
  });
});

describe('in the editor (M2c §6)', () => {
  it('the list opens on [[ and Tab accepts', async () => {
    mockIPC(() => [REX]);
    const v = editor('See [[');
    act(() => {
      startCompletion(v);
    });
    await vi.waitFor(() =>
      expect(document.querySelector('.cm-tooltip-autocomplete')).toHaveTextContent('Generator Rex'),
    );
    // CodeMirror ignores accept for `interactionDelay` (75 ms) after the list opens.
    await act(() => new Promise((r) => setTimeout(r, 100)));
    act(() => {
      v.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      );
    });
    expect(v.state.doc.toString()).toBe('See [[rex-draft|Generator Rex]]');
    expect(acceptCompletion(v)).toBe(false);
  });
});
