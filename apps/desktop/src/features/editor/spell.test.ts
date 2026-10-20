import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { act } from '@testing-library/react';
import i18n from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { parsePage } from '../../markdown/parse';
import { useSpellStore } from '../../stores/spellStore';
import {
  clearSpellCache,
  misspelledAt,
  openSpellMenuAt,
  setSpellMenuOpener,
  SPELL_DEBOUNCE_MS,
  spellcheck,
  wordsToCheck,
} from './spell';

const words = (md: string) => wordsToCheck(parsePage(md), md, 0, md.length).map((w) => w.word);

describe('wordsToCheck', () => {
  const cases: [string, string[]][] = [
    ['Una **palabra** mal escrita', ['Una', 'palabra', 'mal', 'escrita']],
    ['see [texto](https://ejemplo.com/ruta) here', ['see', 'texto', 'here']],
    ['visit https://ejemplo.com/ruta now', ['visit', 'now']],
    ['[[Página destino|texto visible]] y [[Sola]]', ['texto', 'visible', 'y', 'Sola']],
    ['```js\nconst variabel = 1\n```\nfin', ['fin']],
    ['code `noSeRevisa` and $x^2 + y$ math', ['code', 'and', 'math']],
    ['---\ntitle: Titulo\n---\nCuerpo', ['Cuerpo']],
    ['#etiqueta y texto', ['y', 'texto']],
    ['NASA iPhone v2 camelCase normal', ['normal']],
    ['visible %% oculto %% y más', ['visible', 'y', 'más']],
    ["don't don’t", ["don't", 'don’t']],
  ];
  it.each(cases)('%j', (md, expected) => {
    expect(words(md)).toEqual(expected);
  });

  it('a word range excludes its marks', () => {
    const md = '**palabra**';
    expect(wordsToCheck(parsePage(md), md, 0, md.length)).toEqual([
      { from: 2, to: 9, word: 'palabra' },
    ]);
  });

  it('keeps to the range asked for', () => {
    const md = 'uno dos tres';
    expect(wordsToCheck(parsePage(md), md, 4, 7).map((w) => w.word)).toEqual(['dos']);
  });
});

describe('the spellcheck extension', () => {
  let view: EditorView | null = null;
  let calls: string[][] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    clearSpellCache();
    calls = [];
    mockIPC((cmd, args) => {
      if (cmd !== 'spell_check') return null;
      const asked = (args as { words: string[] }).words;
      calls.push(asked);
      return asked.map((w) => w !== 'recieve');
    });
  });

  afterEach(() => {
    view?.destroy();
    view = null;
    clearMocks();
    vi.useRealTimers();
  });

  function editor(doc: string): EditorView {
    view = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      state: EditorState.create({ doc, extensions: [spellcheck()] }),
    });
    return view;
  }

  /** Lets the debounce fire and the check's reply land. */
  const settle = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPELL_DEBOUNCE_MS + 10);
    });
  };

  const underlined = (v: EditorView) =>
    [...v.contentDOM.querySelectorAll('.cm-nimw-misspelled')].map((e) => e.textContent);

  it('underlines misspelled words and maps them through edits', async () => {
    const v = editor('I recieve mail');
    await settle();
    expect(underlined(v)).toEqual(['recieve']);
    expect(misspelledAt(v.state, 4)).toEqual({ from: 2, to: 9, word: 'recieve' });
    expect(misspelledAt(v.state, 0)).toBeNull();
    act(() => v.dispatch({ changes: { from: 0, insert: 'Today ' } }));
    expect(misspelledAt(v.state, 10)).toEqual({ from: 8, to: 15, word: 'recieve' });
  });

  it('checks only uncached words, once per debounce, and bump re-checks', async () => {
    const v = editor('uno recieve');
    await settle();
    expect(calls).toEqual([['uno', 'recieve']]);
    act(() => v.dispatch({ changes: { from: v.state.doc.length, insert: ' d' } }));
    act(() => v.dispatch({ changes: { from: v.state.doc.length, insert: 'os' } }));
    await settle();
    expect(calls).toEqual([['uno', 'recieve'], ['dos']]);
    act(() => useSpellStore.getState().bump());
    await settle();
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual(['uno', 'recieve', 'dos']);
  });

  // Round 3b final review #3: answers that arrive after a bump are stale.
  it('drops a check answered after the dictionaries changed', async () => {
    let answer: (v: boolean[]) => void = () => {};
    let first = true;
    clearMocks();
    mockIPC((cmd, args) => {
      if (cmd !== 'spell_check') return null;
      const asked = (args as { words: string[] }).words;
      calls.push(asked);
      if (first) {
        first = false;
        return new Promise<boolean[]>((resolve) => (answer = resolve));
      }
      return asked.map(() => true);
    });
    const v = editor('uno nimw');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPELL_DEBOUNCE_MS + 10);
    });
    act(() => useSpellStore.getState().bump());
    await act(async () => {
      answer([true, false]);
      await Promise.resolve();
    });
    await settle();
    expect(calls).toEqual([
      ['uno', 'nimw'],
      ['uno', 'nimw'],
    ]);
    expect(underlined(v)).toEqual([]);
  });

  // Round 3b final review #8: another UI language means other answers.
  it('a language change re-checks', async () => {
    const before = useSpellStore.getState().setKey;
    await act(async () => {
      await i18n.changeLanguage('es');
    });
    expect(useSpellStore.getState().setKey).toBe(before + 1);
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  it('the menu opens on a misspelled word only', async () => {
    const v = editor('I recieve mail');
    await settle();
    const opened: string[] = [];
    setSpellMenuOpener(v, (target) => opened.push(target.word));
    expect(openSpellMenuAt(v, 0, { x: 1, y: 1 })).toBe(false);
    expect(openSpellMenuAt(v, 5, { x: 1, y: 1 })).toBe(true);
    expect(opened).toEqual(['recieve']);
    setSpellMenuOpener(v, null);
    expect(openSpellMenuAt(v, 5, { x: 1, y: 1 })).toBe(false);
  });
});
