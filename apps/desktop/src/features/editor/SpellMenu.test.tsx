import { undo, history } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { useSpellStore } from '../../stores/spellStore';
import { SpellMenu } from './SpellMenu';

let view: EditorView;
let calls: { cmd: string; args: unknown }[] = [];
let suggestions: string[] = ['receive', 'relieve'];

beforeEach(() => {
  calls = [];
  suggestions = ['receive', 'relieve'];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'spell_suggest') return suggestions;
    return null;
  });
  view = new EditorView({
    parent: document.body.appendChild(document.createElement('div')),
    state: EditorState.create({ doc: 'I recieve mail', extensions: [history()] }),
  });
});

afterEach(() => {
  view.destroy();
  clearMocks();
});

const target = { from: 2, to: 9, word: 'recieve' };

function open(onClose: (refocus: boolean) => void = () => {}) {
  render(<SpellMenu view={view} target={target} anchor={{ x: 10, y: 10 }} onClose={onClose} />);
}

describe('SpellMenu', () => {
  it('lists up to 7 suggestions, then Add to dictionary and Ignore', async () => {
    suggestions = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'];
    open();
    const menu = screen.getByRole('menu', { name: 'Spelling: recieve' });
    await waitFor(() => expect(screen.getAllByRole('menuitem')).toHaveLength(9));
    const names = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(names.slice(0, 7)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']);
    expect(names.slice(7)).toEqual(['Add to dictionary', 'Ignore']);
    expect(menu).toBeTruthy();
  });

  it('shows "No suggestions" when there are none', async () => {
    suggestions = [];
    open();
    await waitFor(() => expect(screen.getByText('No suggestions')).toBeTruthy());
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual([
      'Add to dictionary',
      'Ignore',
    ]);
  });

  it('a suggestion replaces the word in one undo step', async () => {
    let closed: boolean | null = null;
    open((refocus) => (closed = refocus));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'receive' }));
    expect(view.state.doc.toString()).toBe('I receive mail');
    expect(closed).toBe(true);
    act(() => void undo(view));
    expect(view.state.doc.toString()).toBe('I recieve mail');
  });

  it('Add to dictionary calls spell_add_word and bumps', async () => {
    const before = useSpellStore.getState().setKey;
    open();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add to dictionary' }));
    await waitFor(() => expect(useSpellStore.getState().setKey).toBe(before + 1));
    expect(calls).toContainEqual({ cmd: 'spell_add_word', args: { word: 'recieve' } });
  });

  it('Ignore calls spell_ignore and bumps', async () => {
    const before = useSpellStore.getState().setKey;
    open();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ignore' }));
    await waitFor(() => expect(useSpellStore.getState().setKey).toBe(before + 1));
    expect(calls).toContainEqual({ cmd: 'spell_ignore', args: { word: 'recieve' } });
  });

  it('Escape closes asking for focus back; arrows move between items', async () => {
    let closed: boolean | null = null;
    open((refocus) => (closed = refocus));
    const first = await screen.findByRole('menuitem', { name: 'receive' });
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'relieve' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Ignore' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(closed).toBe(true);
  });

  // Round 3b final review #11.
  it('Tab closes and gives focus back to the editor', async () => {
    let closed: boolean | null = null;
    open((refocus) => (closed = refocus));
    const first = await screen.findByRole('menuitem', { name: 'receive' });
    fireEvent.keyDown(first, { key: 'Tab' });
    expect(closed).toBe(true);
  });

  it('stays inside the window when opened at its edge', async () => {
    render(
      <SpellMenu
        view={view}
        target={target}
        anchor={{ x: window.innerWidth - 5, y: window.innerHeight - 5 }}
        onClose={() => {}}
      />,
    );
    const menu = await screen.findByRole('menu');
    await screen.findByRole('menuitem', { name: 'receive' });
    expect(parseFloat(menu.style.left)).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(parseFloat(menu.style.top)).toBeLessThanOrEqual(window.innerHeight - 8);
  });

  it('closes without a change when the word is no longer there', async () => {
    let closed: boolean | null = null;
    open((refocus) => (closed = refocus));
    act(() => view.dispatch({ changes: { from: 0, to: 9, insert: 'We get' } }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'receive' }));
    expect(view.state.doc.toString()).toBe('We get mail');
    expect(closed).toBe(true);
  });
});
