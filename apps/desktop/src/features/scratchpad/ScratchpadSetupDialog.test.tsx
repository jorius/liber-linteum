import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { resetVaultStore } from '../../stores/vaultStore';
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

const DEFAULT = '/Users/me/Documents/Notes In My Way/Scratchpad';
const report = { pages: 0, warnings: [] };

function setupBackend(extra: Record<string, Handler> = {}) {
  return backend({
    scratchpad_default: () => DEFAULT,
    scratchpad_set: (a) => ({ ...DEFAULT_SETTINGS, scratchpadPath: a.path }),
    scratchpad_open: () => ({ name: 'Scratchpad', root: DEFAULT, report, scratchpad: true }),
    vault_tree: () => [],
    quick_notes_state: () => ({ folder: null, autoNamed: [] }),
    quick_note_create: (a) => `${a.name}.md`,
    page_get: (a) => ({ path: a.path, title: 'x', text: '', tags: [] }),
    page_read: () => ({ text: '', hash: 'h' }),
    ...extra,
  });
}

let now = Date.parse('2026-10-15T10:00:00');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  now += 60_000;
  vi.setSystemTime(now);
  useToastStore.getState().clear();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, warning: null, loaded: true });
  useUiStore.setState({ dialog: { type: 'scratchpadSetup', then: 'quickNote' } });
});

afterEach(async () => {
  vi.useRealTimers();
  useUiStore.setState({ dialog: null });
  await resetVaultStore();
  useScratchpadStore.getState().reset();
  clearMocks();
});

describe('"Where should quick notes live?" (M4c §2)', () => {
  it('offers the default, creates it and takes the quick note', async () => {
    const calls = setupBackend();
    render(<ScratchpadHost />);
    const dialog = await screen.findByRole('dialog', { name: 'Where should quick notes live?' });
    expect(await screen.findByText(DEFAULT)).toBeInTheDocument();
    // The folder is a named group holding its path (final review M11).
    expect(screen.getByRole('group', { name: 'Folder' })).toHaveTextContent(DEFAULT);
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(calls.find(([c]) => c === 'scratchpad_set')?.[1]).toEqual({ path: DEFAULT });
    expect(useSettingsStore.getState().settings.scratchpadPath).toBe(DEFAULT);
    await waitFor(() => expect(calls.some(([c]) => c === 'quick_note_create')).toBe(true));
  });

  it('Choose folder… replaces the place; a cancelled pick keeps it', async () => {
    let pick: string | null = null;
    const calls = setupBackend({ scratchpad_choose: () => pick });
    render(<ScratchpadHost />);
    await screen.findByText(DEFAULT);
    await userEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    expect(screen.getByText(DEFAULT)).toBeInTheDocument();
    pick = '/Users/me/Dropbox/Quick';
    await userEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    expect(await screen.findByText('/Users/me/Dropbox/Quick')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(calls.find(([c]) => c === 'scratchpad_set')?.[1]).toEqual({
        path: '/Users/me/Dropbox/Quick',
      }),
    );
  });

  it('Cancel and Escape change nothing', async () => {
    const calls = setupBackend();
    render(<ScratchpadHost />);
    await screen.findByText(DEFAULT);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useUiStore.getState().dialog).toBeNull();
    useUiStore.setState({ dialog: { type: 'scratchpadSetup', then: 'none' } });
    await screen.findByText(DEFAULT);
    await userEvent.keyboard('{Escape}');
    expect(useUiStore.getState().dialog).toBeNull();
    expect(calls.some(([c]) => c === 'scratchpad_set')).toBe(false);
  });

  it('a refused folder says why and stays open', async () => {
    setupBackend({
      scratchpad_set: () => {
        throw { kind: 'io', message: 'permission denied' };
      },
    });
    render(<ScratchpadHost />);
    await screen.findByText(DEFAULT);
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('is keyboard-first and axe-clean', async () => {
    setupBackend();
    render(<ScratchpadHost />);
    await screen.findByText(DEFAULT);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Create' }));
    const result = await axe.run(document.body);
    expect(result.violations).toEqual([]);
  });
});
