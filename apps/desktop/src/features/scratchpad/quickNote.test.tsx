import { act, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18next from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeNode } from '../../ipc';
import { clearMocks, emit, mockIPC } from '../../ipc/testing';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { AppShell } from '../shell/AppShell';
import { newQuickNote, QUICK_NOTE_COOLDOWN_MS, quickNoteName } from './quickNote';
import { ScratchpadHost } from './ScratchpadHost';
import { useScratchpadStore } from './scratchpadStore';

type Handler = (args: Record<string, unknown>) => unknown;

function backend(handlers: Record<string, Handler>) {
  const calls: [string, Record<string, unknown>][] = [];
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push([cmd, a]);
      return handlers[cmd]?.(a);
    },
    { shouldMockEvents: true },
  );
  return calls;
}

const report = { pages: 0, warnings: [] };
const vault = { name: 'Worlds', root: '/v/Worlds', report, scratchpad: false };
const scratch = { name: 'Scratchpad', root: '/d/Scratchpad', report, scratchpad: true };

/** A backend where quick notes land in `folder` (`''`: the root). */
function quickBackend(folder: string, extra: Record<string, Handler> = {}) {
  let nodes: TreeNode[] = [];
  let n = 0;
  return backend({
    vault_open: () => vault,
    scratchpad_open: () => scratch,
    vault_tree: () => nodes,
    quick_notes_state: () => ({ folder: folder || null, autoNamed: [] }),
    quick_note_create: (a) => {
      const name = n++ ? `${a.name} ${n - 1}` : String(a.name);
      const path = folder ? `${folder}/${name}.md` : `${name}.md`;
      nodes = [
        ...(folder ? [{ path: folder, kind: 'folder' as const }] : []),
        ...nodes.filter((x) => x.path !== folder),
        { path, kind: 'page' },
      ];
      return path;
    },
    page_get: (a) => ({
      path: a.path,
      title: 'x',
      subtitle: null,
      cover: null,
      coverY: null,
      coverX: null,
      tags: [],
      links: 0,
      backlinks: 0,
      text: '',
      truncated: false,
      binary: false,
    }),
    vault_settings_get: () => ({}),
    page_read: () => ({ text: '', hash: 'h' }),
    ...extra,
  });
}

const created = (calls: [string, Record<string, unknown>][]) =>
  calls.filter(([c]) => c === 'quick_note_create');

let now = Date.parse('2026-10-15T09:05:00');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // Each test starts well past the previous one's cooldown.
  now += 60_000;
  vi.setSystemTime(now);
  usePageStore.getState().clear();
  useToastStore.getState().clear();
  useUiStore.setState({ dialog: null, screen: 'edit' });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, warning: null, loaded: true });
});

afterEach(async () => {
  vi.useRealTimers();
  await resetVaultStore();
  useScratchpadStore.getState().reset();
  clearMocks();
  await i18next.changeLanguage('en');
});

describe('quickNoteName (M4c §7.11)', () => {
  it('is local date and time, localized', async () => {
    const d = new Date(2026, 9, 5, 9, 7);
    expect(quickNoteName(d)).toBe('Quick note 2026-10-05 09.07');
    await i18next.changeLanguage('es');
    expect(quickNoteName(d)).toBe('Nota rápida 2026-10-05 09.07');
  });
});

describe('newQuickNote', () => {
  it('with a vault open: a note in its scratch folder, opened with the cursor at its start', async () => {
    const calls = quickBackend('Scratchpad');
    await useVaultStore.getState().open('/v/Worlds');
    await newQuickNote();
    expect(created(calls)).toHaveLength(1);
    expect(created(calls)[0][1]).toEqual({ name: quickNoteName(new Date()) });
    const path = `Scratchpad/${quickNoteName(new Date())}.md`;
    expect(calls.some(([c]) => c === 'vault_open')).toBe(true);
    expect(calls.some(([c]) => c === 'scratchpad_open')).toBe(false);
    expect(useVaultStore.getState().expanded.has('Scratchpad')).toBe(true);
    expect(useVaultStore.getState().selected).toBe(path);
    expect(usePageStore.getState().jump).toMatchObject({ path, from: 0, to: 0 });
    expect(useScratchpadStore.getState().autoNamed.has(path)).toBe(true);
  });

  it('with no vault and no Scratchpad yet: asks where quick notes should live', async () => {
    const calls = quickBackend('');
    await newQuickNote();
    expect(useUiStore.getState().dialog).toEqual({ type: 'scratchpadSetup', then: 'quickNote' });
    expect(created(calls)).toHaveLength(0);
  });

  it('with no vault: opens the global Scratchpad, then the note at its root', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, scratchpadPath: '/d/Scratchpad' },
    });
    const calls = quickBackend('');
    await newQuickNote();
    expect(useVaultStore.getState().info?.name).toBe('Quick notes');
    expect(created(calls)).toHaveLength(1);
    expect(useVaultStore.getState().selected).toBe(`${quickNoteName(new Date())}.md`);
  });

  it('review focus 4: a Scratchpad that will not open shows the error and the dialog again', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, scratchpadPath: '/Volumes/Gone/Scratchpad' },
    });
    const calls = quickBackend('', {
      scratchpad_open: () => {
        throw { kind: 'io', message: 'read-only file system' };
      },
    });
    await newQuickNote();
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useUiStore.getState().dialog).toEqual({ type: 'scratchpadSetup', then: 'quickNote' });
    expect(created(calls)).toHaveLength(0);
    expect(useVaultStore.getState().status).toBe('closed');
  });

  it('review focus 1: a second trigger within a second makes no second note', async () => {
    const calls = quickBackend('Scratchpad');
    await useVaultStore.getState().open('/v/Worlds');
    await Promise.all([newQuickNote(), newQuickNote()]);
    await newQuickNote();
    expect(created(calls)).toHaveLength(1);
    vi.setSystemTime(Date.now() + QUICK_NOTE_COOLDOWN_MS + 1);
    await newQuickNote();
    expect(created(calls)).toHaveLength(2);
  });

  it('a failed create says why', async () => {
    quickBackend('Scratchpad', {
      quick_note_create: () => {
        throw { kind: 'io', message: 'disk full' };
      },
    });
    await useVaultStore.getState().open('/v/Worlds');
    await newQuickNote();
    expect(useToastStore.getState().toasts[0]).toMatchObject({ tone: 'error' });
  });
});

describe('⌘⇧N and File → New Quick Note', () => {
  it('⌘⇧N takes a quick note (key repeat ignored), and no longer makes a folder', async () => {
    const calls = quickBackend('Scratchpad', { entry_create_folder: () => 'Untitled' });
    await useVaultStore.getState().open('/v/Worlds');
    render(
      <>
        <AppShell />
        <ScratchpadHost />
      </>,
    );
    await userEvent.keyboard('{Meta>}{Shift>}n{/Shift}{/Meta}');
    await waitFor(() => expect(created(calls)).toHaveLength(1));
    expect(calls.some(([c]) => c === 'entry_create_folder')).toBe(false);
    vi.setSystemTime(Date.now() + QUICK_NOTE_COOLDOWN_MS + 1);
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'N',
          code: 'KeyN',
          metaKey: true,
          shiftKey: true,
          repeat: true,
        }),
      );
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(created(calls)).toHaveLength(1);
  });

  it('works on the Welcome screen (Ctrl+Shift+N) and from the menu event', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, scratchpadPath: '/d/Scratchpad' },
    });
    const calls = quickBackend('');
    render(<ScratchpadHost />);
    await userEvent.keyboard('{Control>}{Shift>}n{/Shift}{/Control}');
    await waitFor(() => expect(created(calls)).toHaveLength(1));
    vi.setSystemTime(Date.now() + QUICK_NOTE_COOLDOWN_MS + 1);
    await act(() => emit('menu:quickNote'));
    await waitFor(() => expect(created(calls)).toHaveLength(2));
  });

  it('final review M5: the menu event waits too while a dialog is open', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, scratchpadPath: '/d/Scratchpad' },
    });
    const calls = quickBackend('');
    render(<ScratchpadHost />);
    useUiStore.setState({ dialog: { type: 'settings' } as never });
    await act(() => emit('menu:quickNote'));
    await new Promise((r) => setTimeout(r, 20));
    expect(created(calls)).toHaveLength(0);
    useUiStore.setState({ dialog: null });
  });
});
