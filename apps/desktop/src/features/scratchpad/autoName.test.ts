import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { useEditorStore } from '../../stores/editorStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { AUTO_NAME_IDLE_MS, installAutoName } from './autoName';
import { useScratchpadStore } from './scratchpadStore';
import { AUTOSAVE_MS } from '../editor/pageDoc';

type Handler = (args: Record<string, unknown>) => unknown;

function backend(handlers: Record<string, Handler>) {
  const calls: [string, Record<string, unknown>][] = [];
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push([cmd, a]);
    return handlers[cmd]?.(a);
  });
  return calls;
}

const autonames = (calls: [string, Record<string, unknown>][]) =>
  calls.filter(([c]) => c === 'quick_note_autoname').map(([, a]) => a.path);

/** The editor's state as typing and autosave move it. */
const typing = (path: string) => useEditorStore.setState({ path, dirty: true });
const saved = (path: string) => useEditorStore.setState({ path, dirty: false });

const AFTER_SAVE = AUTO_NAME_IDLE_MS - AUTOSAVE_MS;

let stop: () => void = () => undefined;

beforeEach(() => {
  vi.useFakeTimers();
  useEditorStore.setState({ path: null, dirty: false });
  useScratchpadStore.setState({ folder: 'Scratchpad', autoNamed: new Set(['Scratchpad/Q.md']) });
  stop = installAutoName();
});

afterEach(async () => {
  stop();
  vi.useRealTimers();
  useEditorStore.setState({ path: null, dirty: false });
  useScratchpadStore.getState().reset();
  await resetVaultStore();
  clearMocks();
});

const unchanged: Handler = (a) => ({ path: a.path, autoNamed: true, outcome: null });

describe('naming from the first line while typing (M4c §7.15)', () => {
  it('asks Rust about 2 s after the last keystroke (1.5 s after its save), once', async () => {
    const calls = backend({ quick_note_autoname: unchanged });
    typing('Scratchpad/Q.md');
    saved('Scratchpad/Q.md');
    await vi.advanceTimersByTimeAsync(AFTER_SAVE - 10);
    expect(autonames(calls)).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    expect(autonames(calls)).toEqual(['Scratchpad/Q.md']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(autonames(calls)).toHaveLength(1);
  });

  it('typing again before then waits for the next save', async () => {
    const calls = backend({ quick_note_autoname: unchanged });
    typing('Scratchpad/Q.md');
    saved('Scratchpad/Q.md');
    await vi.advanceTimersByTimeAsync(AFTER_SAVE / 2);
    typing('Scratchpad/Q.md');
    await vi.advanceTimersByTimeAsync(AFTER_SAVE);
    expect(autonames(calls)).toEqual([]);
    saved('Scratchpad/Q.md');
    await vi.advanceTimersByTimeAsync(AFTER_SAVE + 10);
    expect(autonames(calls)).toEqual(['Scratchpad/Q.md']);
  });

  it('a note named by hand (not flagged) is never asked about', async () => {
    const calls = backend({ quick_note_autoname: unchanged });
    typing('Mine.md');
    saved('Mine.md');
    await vi.advanceTimersByTimeAsync(AUTO_NAME_IDLE_MS * 2);
    expect(autonames(calls)).toEqual([]);
  });

  it('the editor losing focus, or another page opening, asks at once', async () => {
    const calls = backend({ quick_note_autoname: unchanged });
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const content = document.createElement('div');
    content.tabIndex = 0;
    editor.append(content);
    const outside = document.createElement('button');
    document.body.append(editor, outside);
    typing('Scratchpad/Q.md');
    content.focus();
    outside.focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(autonames(calls)).toEqual(['Scratchpad/Q.md']);
    typing('Scratchpad/Q.md');
    saved('Scratchpad/Q.md');
    useEditorStore.setState({ path: 'Other.md', dirty: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(autonames(calls)).toEqual(['Scratchpad/Q.md', 'Scratchpad/Q.md']);
    editor.remove();
    outside.remove();
  });

  it('a rename moves the note in the store and the app; an unflagged answer drops it', async () => {
    useVaultStore.setState({ status: 'open', selected: 'Scratchpad/Q.md' });
    backend({
      quick_note_autoname: () => ({
        path: 'Scratchpad/Trip.md',
        autoNamed: true,
        outcome: {
          moved: [['Scratchpad/Q.md', 'Scratchpad/Trip.md']],
          updatedFiles: [],
          updatedLinks: 0,
          failed: [],
        },
      }),
      vault_tree: () => [{ path: 'Scratchpad/Trip.md', kind: 'page' }],
    });
    typing('Scratchpad/Q.md');
    saved('Scratchpad/Q.md');
    await vi.advanceTimersByTimeAsync(AFTER_SAVE + 10);
    expect([...useScratchpadStore.getState().autoNamed]).toEqual(['Scratchpad/Trip.md']);
    expect(useVaultStore.getState().selected).toBe('Scratchpad/Trip.md');

    backend({ quick_note_autoname: (a) => ({ path: a.path, autoNamed: false, outcome: null }) });
    typing('Scratchpad/Trip.md');
    saved('Scratchpad/Trip.md');
    await vi.advanceTimersByTimeAsync(AFTER_SAVE + 10);
    expect(useScratchpadStore.getState().autoNamed.size).toBe(0);
  });

  it('review focus 2: never two at once; a trigger during a run runs once more after it', async () => {
    let release: () => void = () => undefined;
    const calls = backend({
      quick_note_autoname: (a) =>
        new Promise((r) => {
          release = () => r(unchanged(a));
        }),
    });
    typing('Scratchpad/Q.md');
    saved('Scratchpad/Q.md');
    await vi.advanceTimersByTimeAsync(AFTER_SAVE + 10);
    expect(autonames(calls)).toHaveLength(1);
    typing('Scratchpad/Q.md');
    saved('Scratchpad/Q.md');
    await vi.advanceTimersByTimeAsync(AFTER_SAVE + 10);
    typing('Scratchpad/Q.md');
    saved('Scratchpad/Q.md');
    await vi.advanceTimersByTimeAsync(AFTER_SAVE + 10);
    expect(autonames(calls)).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(autonames(calls)).toHaveLength(2);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(autonames(calls)).toHaveLength(2);
  });

  it('a failure leaves the name as it is, quietly', async () => {
    const calls = backend({
      quick_note_autoname: () => {
        throw { kind: 'alreadyExists', message: 'taken' };
      },
    });
    typing('Scratchpad/Q.md');
    saved('Scratchpad/Q.md');
    await vi.advanceTimersByTimeAsync(AFTER_SAVE + 10);
    expect(autonames(calls)).toHaveLength(1);
    expect(useScratchpadStore.getState().autoNamed.has('Scratchpad/Q.md')).toBe(true);
  });
});
