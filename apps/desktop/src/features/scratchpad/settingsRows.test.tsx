import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { RecentList } from '../welcome/RecentList';
import { ScratchFolderSetting } from './ScratchFolderSetting';
import { ScratchpadLocation } from './ScratchpadLocation';
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

const report = {
  files: 0,
  pages: 0,
  parsed: 0,
  skippedUnchanged: 0,
  removed: 0,
  warnings: [],
  durationMs: 0,
};

beforeEach(() => {
  useToastStore.getState().clear();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, warning: null, loaded: true });
});

afterEach(async () => {
  await resetVaultStore();
  useScratchpadStore.getState().reset();
  clearMocks();
});

describe('the recent list (M4c §7.19)', () => {
  it('shows the global Scratchpad as Quick notes and opens it without a path', async () => {
    const calls = backend({
      vaults_recent: () => [
        {
          path: '/d/Scratchpad',
          name: 'Scratchpad',
          openedAt: '',
          missing: false,
          scratchpad: true,
        },
        { path: '/v/Worlds', name: 'Worlds', openedAt: '', missing: false },
      ],
      scratchpad_open: () => ({
        name: 'Scratchpad',
        root: '/d/Scratchpad',
        report,
        scratchpad: true,
      }),
      vault_tree: () => [],
    });
    render(<RecentList />);
    const quick = await screen.findByRole('button', { name: /^Quick notes/ });
    expect(quick.querySelector('[data-quick-note-icon]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Remove Quick notes from recent' })).toBeVisible();
    await userEvent.click(quick);
    await waitFor(() => expect(useVaultStore.getState().status).toBe('open'));
    expect(calls.find(([c]) => c === 'scratchpad_open')?.[1]).toEqual({});
    expect(calls.some(([c]) => c === 'vault_open')).toBe(false);
  });
});

describe('Settings → Files: the quick notes folder (M4c §2)', () => {
  it('before the first quick note: says so, and Choose… sets it', async () => {
    let chosen: string | null = null;
    const calls = backend({
      scratchpad_choose: () => chosen,
      scratchpad_set: (a) => ({ ...DEFAULT_SETTINGS, scratchpadPath: a.path }),
    });
    const { container } = render(<ScratchpadLocation />);
    expect(screen.getByText('Chosen the first time you take a quick note.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Choose…' }));
    expect(calls.some(([c]) => c === 'scratchpad_set')).toBe(false);
    chosen = '/Users/me/Quick';
    await userEvent.click(screen.getByRole('button', { name: 'Choose…' }));
    await screen.findByText('/Users/me/Quick');
    expect(useSettingsStore.getState().settings.scratchpadPath).toBe('/Users/me/Quick');
    expect(screen.getByRole('button', { name: 'Change…' })).toBeVisible();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('a refused folder toasts', async () => {
    backend({
      scratchpad_choose: () => '/x',
      scratchpad_set: () => {
        throw { kind: 'notPermitted', message: 'no' };
      },
    });
    render(<ScratchpadLocation />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose…' }));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
  });
});

describe('Settings → This vault: the scratch folder (M4c §7.8)', () => {
  it('renames it on Enter and applies the move', async () => {
    useScratchpadStore.setState({ folder: 'Scratchpad' });
    useVaultStore.setState({ status: 'open', info: { name: 'W', root: '/w', report } });
    const calls = backend({
      scratch_folder_set: (a) => ({
        folder: a.name,
        from: 'Scratchpad',
        outcome: { moved: [['Scratchpad', a.name]], updatedFiles: [], updatedLinks: 0, failed: [] },
      }),
      vault_tree: () => [{ path: 'Inbox', kind: 'folder' }],
      quick_notes_state: () => ({ folder: 'Inbox', autoNamed: [] }),
    });
    render(<ScratchFolderSetting />);
    const field = screen.getByRole('textbox', { name: 'Quick notes folder' });
    expect(field).toHaveValue('Scratchpad');
    await userEvent.clear(field);
    await userEvent.type(field, 'Inbox{Enter}');
    await waitFor(() =>
      expect(calls.find(([c]) => c === 'scratch_folder_set')?.[1]).toEqual({ name: 'Inbox' }),
    );
    await waitFor(() => expect(useScratchpadStore.getState().folder).toBe('Inbox'));
    expect(useVaultStore.getState().nodes.map((n) => n.path)).toEqual(['Inbox']);
  });

  it('refuses a bad name inline, and saves nothing unchanged', async () => {
    useScratchpadStore.setState({ folder: 'Scratchpad' });
    const calls = backend({});
    render(<ScratchFolderSetting />);
    const field = screen.getByRole('textbox', { name: 'Quick notes folder' });
    await userEvent.clear(field);
    await userEvent.type(field, 'a/b{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('/');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    await userEvent.clear(field);
    await userEvent.type(field, 'Scratchpad');
    field.blur();
    expect(calls.some(([c]) => c === 'scratch_folder_set')).toBe(false);
  });

  it('is absent in the global Scratchpad (its root is the scratch place)', () => {
    backend({});
    render(<ScratchFolderSetting />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
