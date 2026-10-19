import { EditorView } from '@codemirror/view';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import type { LinkSuggestion } from '../../ipc';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { fakeDisk } from '../../test/fakeDisk';
import { Editor } from './Editor';
import { PageDoc } from './pageDoc';

const PAGES: LinkSuggestion[] = [
  { path: 'Chars/Sparda.md', kind: 'page', title: 'Sparda', target: 'Sparda' },
  { path: 'Chars/rex-draft.md', kind: 'page', title: 'Generator Rex', target: 'rex-draft' },
  { path: 'Chars/assets/rex.png', kind: 'attachment', title: null, target: 'rex.png' },
];

const hooks = { onChange: () => undefined, onConflictCopy: () => undefined };
const viewOf = (): EditorView =>
  EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
const text = () => viewOf().state.doc.toString();

async function mount(doc: string, from = 0, to = from) {
  const asked: unknown[] = [];
  fakeDisk(
    { 'P.md': doc },
    {
      link_suggest: (args) => {
        asked.push(args);
        const q = String(args.query).toLowerCase();
        return PAGES.filter(
          (p) => (p.title ?? p.path).toLowerCase().includes(q) || p.path.includes(q),
        );
      },
    },
  );
  const res = await PageDoc.load('P.md', hooks);
  if (!res.ok) throw new Error(res.error.message);
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  render(<Editor doc={res.value} mode="source" label="P" />);
  act(() => {
    viewOf().focus();
    viewOf().dispatch({ selection: { anchor: from, head: to } });
  });
  return asked;
}

const pressModK = () =>
  act(() => {
    viewOf().contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'k',
        bubbles: true,
        cancelable: true,
        ...(/Mac|iP(hone|ad)/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
      }),
    );
  });

/** The picker's own controls (the toolbar's heading menu is a combobox too). */
const picker = () => screen.getByRole('combobox', { name: 'Link to…' });
const pickerGone = () => screen.queryByRole('combobox', { name: 'Link to…' });
const options = () =>
  within(screen.getByRole('listbox', { name: 'Pages' })).queryAllByRole('option');

afterEach(() => clearMocks());

describe('Link picker (M2c §6.3)', () => {
  it('⌘K on a selection links it to the chosen page: [[target|selected text]]', async () => {
    const asked = await mount('see the twins now\n', 4, 13);
    pressModK();
    const box = picker();
    expect(box).toHaveFocus();
    await userEvent.type(box, 'spa');
    await waitFor(() =>
      expect(options().map((o) => o.textContent)).toEqual(['SpardaChars/Sparda.md']),
    );
    await userEvent.keyboard('{Enter}');
    expect(text()).toBe('see [[Sparda|the twins]] now\n');
    expect(pickerGone()).toBeNull();
    expect(viewOf().hasFocus).toBe(true);
    expect(asked.at(-1)).toEqual({ source: 'P.md', query: 'spa', embed: false });
  });

  it('without a selection: [[target]] or [[target|Title]] when the title differs', async () => {
    await mount('x\n', 0);
    pressModK();
    await userEvent.type(picker(), 'rex');
    await waitFor(() => expect(options()).toHaveLength(1));
    await userEvent.keyboard('{Enter}');
    expect(text()).toBe('[[rex-draft|Generator Rex]]x\n');
  });

  it('a web address becomes the first option: [text](url)', async () => {
    await mount('see site\n', 4, 8);
    pressModK();
    await userEvent.type(picker(), 'https://example.org');
    expect(options()[0]).toHaveTextContent('Link to https://example.org');
    await userEvent.keyboard('{Enter}');
    expect(text()).toBe('see [site](https://example.org)\n');
  });

  it('arrows choose another page; Escape closes and keeps the selection', async () => {
    await mount('ab\n', 0, 2);
    pressModK();
    await waitFor(() => expect(options()).toHaveLength(2));
    const box = picker();
    await userEvent.keyboard('{ArrowDown}');
    const second = options()[1];
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(box).toHaveAttribute('aria-activedescendant', second.id);
    await userEvent.keyboard('{Escape}');
    expect(pickerGone()).toBeNull();
    expect(text()).toBe('ab\n');
    expect(viewOf().state.selection.main).toMatchObject({ from: 0, to: 2 });
    expect(viewOf().hasFocus).toBe(true);
  });

  it('selected text with [[, ]], | or brackets is made link-safe in the alias (final review M11)', async () => {
    const doc = 'a [[x]] | list[0] b\nz\n';
    await mount(doc, 0, doc.indexOf('\nz'));
    pressModK();
    await userEvent.type(picker(), 'spa');
    await waitFor(() => expect(options()).toHaveLength(1));
    await userEvent.keyboard('{Enter}');
    expect(text()).toBe('[[Sparda|a x list 0 b]]\nz\n');
  });

  it('a selection of only link syntax falls back to the page title (final review M11)', async () => {
    await mount('[[]]|\n', 0, 5);
    pressModK();
    await userEvent.type(picker(), 'rex');
    await waitFor(() => expect(options()).toHaveLength(1));
    await userEvent.keyboard('{Enter}');
    expect(text()).toBe('[[rex-draft|Generator Rex]]\n');
  });

  it('links the live selection when the text changes while the picker is open (final review M11)', async () => {
    await mount('see the twins now\n', 4, 13);
    pressModK();
    await userEvent.type(picker(), 'spa');
    await waitFor(() => expect(options()).toHaveLength(1));
    // A merge from disk lands while the picker is open.
    act(() => viewOf().dispatch({ changes: { from: 0, insert: 'We ' } }));
    await userEvent.keyboard('{Enter}');
    expect(text()).toBe('We see [[Sparda|the twins]] now\n');
  });

  it('the toolbar Link button opens the picker too; no axe violations', async () => {
    await mount('x\n', 0);
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    const box = picker();
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    const violations = await axe
      .run(box.parentElement!, { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
  });
});
