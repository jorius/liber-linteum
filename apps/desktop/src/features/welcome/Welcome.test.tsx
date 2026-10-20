import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { useUiStore } from '../../stores/uiStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { lastOpened } from './RecentList';
import { Welcome } from './Welcome';

const info = { name: 'Notes', root: '/v/Notes', report: { pages: 0, warnings: [] } };

function backend(handlers: Record<string, (a: Record<string, unknown>) => unknown>) {
  const calls: [string, Record<string, unknown>][] = [];
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push([cmd, a]);
    return handlers[cmd]?.(a);
  });
  return calls;
}

afterEach(async () => {
  await resetVaultStore();
  clearMocks();
});

describe('Welcome screen', () => {
  it('shows the app name, tagline and the vault actions, Notion import included', async () => {
    backend({ vaults_recent: () => [] });
    render(<Welcome version="0.1.0" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Notes In My Way' })).toBeInTheDocument();
    expect(screen.getByText(/Private notes that live on your disk/)).toBeInTheDocument();
    for (const name of ['New vault', 'Open folder as vault', 'Open an Obsidian vault']) {
      expect(screen.getByRole('button', { name })).toBeEnabled();
    }
    expect(screen.getByText('v0.1.0')).toBeInTheDocument();
    // M7: the Notion import opens its dialog.
    await userEvent.click(screen.getByRole('button', { name: 'Import from Notion…' }));
    expect(useUiStore.getState().dialog).toEqual({ type: 'notionImport' });
    useUiStore.setState({ dialog: null });
  });

  it('VLT-01 create picks a folder and creates the vault', async () => {
    const calls = backend({
      vaults_recent: () => [],
      'plugin:dialog|open': () => '/v/Notes',
      vault_create: () => info,
      vault_tree: () => [],
    });
    render(<Welcome version={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'New vault' }));
    await waitFor(() => expect(useVaultStore.getState().status).toBe('open'));
    expect(calls.find(([c]) => c === 'vault_create')?.[1]).toEqual({ path: '/v/Notes' });
  });

  it.each(['Open folder as vault', 'Open an Obsidian vault'])(
    'VLT-01 "%s" picks a folder and opens it',
    async (name) => {
      const calls = backend({
        vaults_recent: () => [],
        'plugin:dialog|open': () => '/v/Notes',
        vault_open: () => info,
        vault_tree: () => [],
      });
      render(<Welcome version={null} />);
      await userEvent.click(screen.getByRole('button', { name }));
      await waitFor(() => expect(useVaultStore.getState().status).toBe('open'));
      expect(calls.find(([c]) => c === 'vault_open')?.[1]).toEqual({ path: '/v/Notes' });
    },
  );

  it('a cancelled folder picker does nothing', async () => {
    const calls = backend({ vaults_recent: () => [], 'plugin:dialog|open': () => null });
    render(<Welcome version={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open folder as vault' }));
    expect(calls.map(([c]) => c)).not.toContain('vault_open');
    expect(useVaultStore.getState().status).toBe('closed');
  });

  /** Review Focus: a recent vault whose drive is unmounted is shown as missing,
   * can't be opened, and can be removed from the list. */
  it('review_focus recent vaults: open, missing (unmounted) and forget', async () => {
    let recent = [
      { path: '/v/Notes', name: 'Notes', openedAt: '2026-10-12T16:00:00Z', missing: false },
      { path: '/Volumes/USB/Old', name: 'Old', openedAt: '2026-10-01T09:00:00Z', missing: true },
    ];
    const calls = backend({
      vaults_recent: () => recent,
      vaults_forget: (a) => {
        recent = recent.filter((r) => r.path !== a.path);
      },
      vault_open: () => info,
      vault_tree: () => [],
    });
    render(<Welcome version={null} />);
    const list = await screen.findByRole('list', { name: 'Recent vaults' });
    const old = within(list).getByRole('button', { name: /^Old/ });
    expect(old).toBeDisabled();
    expect(within(list).getByText('Folder not found')).toBeInTheDocument();
    await userEvent.click(within(list).getByRole('button', { name: 'Remove Old from recent' }));
    await waitFor(() => expect(within(list).queryByText('Old')).not.toBeInTheDocument());
    await userEvent.click(within(list).getByRole('button', { name: /^Notes/ }));
    await waitFor(() => expect(useVaultStore.getState().status).toBe('open'));
    expect(calls.find(([c]) => c === 'vault_open')?.[1]).toEqual({ path: '/v/Notes' });
  });

  it('Q-I18N-1 language toggle switches to Spanish and saves the choice', async () => {
    const calls = backend({
      vaults_recent: () => [],
      settings_set: (a) => ({
        version: 1,
        theme: 'system',
        rewriteLinks: true,
        confirmDelete: true,
        ...(a.patch as object),
      }),
    });
    render(<Welcome version={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Español' }));
    expect(await screen.findByText(/Notas privadas que viven en tu disco/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Español' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() =>
      expect(calls.find(([c]) => c === 'settings_set')?.[1]).toEqual({ patch: { language: 'es' } }),
    );
  });

  it('credits React Flow, whose canvas badge is hidden (M3a §9, final review m6)', () => {
    backend({ vaults_recent: () => [] });
    render(<Welcome version="0.1.0" />);
    expect(screen.getByText('Global View made with React Flow (MIT).')).toBeInTheDocument();
  });

  it('hides the version when it is unknown', () => {
    backend({ vaults_recent: () => [] });
    render(<Welcome version={null} />);
    expect(screen.queryByText(/^v\d/)).not.toBeInTheDocument();
  });

  it('NFR-10 has no axe violations (with recent vaults)', async () => {
    backend({
      vaults_recent: () => [
        { path: '/v/Notes', name: 'Notes', openedAt: '2026-10-12T16:00:00Z', missing: false },
      ],
    });
    const { container } = render(<Welcome version="0.1.0" />);
    await screen.findByRole('list', { name: 'Recent vaults' });
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('M4c §2: Quick note asks where quick notes live the first time', async () => {
    backend({ vaults_recent: () => [] });
    render(<Welcome version={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Quick note' }));
    expect(useUiStore.getState().dialog).toEqual({ type: 'scratchpadSetup', then: 'quickNote' });
    useUiStore.setState({ dialog: null });
  });

  describe('R3 §7 launcher', () => {
    const vault = (name: string, extra: Partial<Record<string, unknown>> = {}) => ({
      path: `/v/${name}`,
      name,
      openedAt: '2026-10-12T16:00:00Z',
      missing: false,
      ...extra,
    });

    it('puts the three ways to start first, with their shortcuts, and the rest under "More ways to start"', async () => {
      backend({ vaults_recent: () => [] });
      render(<Welcome version="0.1.0" />);
      for (const name of ['New vault', 'Open folder as vault', 'Quick note']) {
        expect(screen.getByRole('button', { name })).toHaveAttribute('aria-keyshortcuts');
      }
      const more = screen.getByRole('group', { name: 'More ways to start' });
      for (const name of ['Open an Obsidian vault', 'Open a single file…', 'Import from Notion…']) {
        expect(within(more).getByRole('button', { name })).toBeEnabled();
      }
      expect(await screen.findByText('No recent vaults yet.')).toBeInTheDocument();
    });

    it.each([
      [{ key: 'n', ctrlKey: true }, 'vault_create'],
      [{ key: 'o', ctrlKey: true }, 'vault_open'],
    ])('the shortcut %o on the Welcome screen runs %s', async (key, command) => {
      const calls = backend({
        vaults_recent: () => [],
        'plugin:dialog|open': () => '/v/Notes',
        vault_create: () => info,
        vault_open: () => info,
        vault_tree: () => [],
      });
      render(<Welcome version={null} />);
      window.dispatchEvent(new KeyboardEvent('keydown', { ...key, bubbles: true }));
      await waitFor(() => expect(calls.map(([c]) => c)).toContain(command));
    });

    it('filters by name or path once there are more than five vaults', async () => {
      const six = ['Cybersec', 'Personal', 'Latin', 'Work', 'Recipes', 'Travel'].map((n) =>
        vault(n),
      );
      six[2] = vault('Latin', { path: '/Users/me/Documents/Classics' });
      backend({ vaults_recent: () => six });
      render(<Welcome version={null} />);
      const list = await screen.findByRole('list', { name: 'Recent vaults' });
      const filter = screen.getByRole('searchbox', { name: 'Filter vaults' });
      await userEvent.type(filter, 'classics');
      expect(within(list).getAllByRole('listitem')).toHaveLength(1);
      expect(within(list).getByRole('button', { name: /^Latin/ })).toBeInTheDocument();
      await userEvent.clear(filter);
      await userEvent.type(filter, 'zzz');
      expect(screen.getByText('No vaults match “zzz”.')).toBeInTheDocument();
    });

    it('shows no filter for five vaults or fewer', async () => {
      backend({ vaults_recent: () => ['A', 'B', 'C', 'D', 'E'].map((n) => vault(n)) });
      render(<Welcome version={null} />);
      await screen.findByRole('list', { name: 'Recent vaults' });
      expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    });

    it('reveals a vault in the file manager; a missing one has nothing to reveal', async () => {
      const calls = backend({
        vaults_recent: () => [vault('Notes'), vault('Old', { missing: true })],
        vaults_reveal: () => null,
      });
      render(<Welcome version={null} />);
      const list = await screen.findByRole('list', { name: 'Recent vaults' });
      await userEvent.click(
        within(list).getByRole('button', { name: 'Show Notes in the file manager' }),
      );
      expect(calls.find(([c]) => c === 'vaults_reveal')?.[1]).toEqual({ path: '/v/Notes' });
      expect(within(list).queryByRole('button', { name: /^Show Old/ })).not.toBeInTheDocument();
      expect(within(list).getByRole('button', { name: 'Remove Old from recent' })).toBeEnabled();
    });

    it('says when each vault was last opened', async () => {
      const twoDays = new Date(Date.now() - 2 * 86_400_000).toISOString();
      backend({ vaults_recent: () => [vault('Notes', { openedAt: twoDays })] });
      render(<Welcome version={null} />);
      const list = await screen.findByRole('list', { name: 'Recent vaults' });
      expect(within(list).getByText('2 days ago')).toBeInTheDocument();
    });
  });
});

describe('lastOpened', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  it.each([
    ['2026-10-20T11:55:00Z', 'en', '5 minutes ago'],
    ['2026-10-20T09:00:00Z', 'en', '3 hours ago'],
    ['2026-10-19T09:00:00Z', 'en', 'yesterday'],
    ['2026-10-13T12:00:00Z', 'en', 'last week'],
    ['2026-08-10T12:00:00Z', 'en', '2 months ago'],
    ['2026-10-19T09:00:00Z', 'es', 'ayer'],
    ['2026-10-20T11:59:50Z', 'en', 'now'],
  ])('%s in %s reads "%s"', (iso, lng, want) => {
    expect(lastOpened(iso, now, lng)).toBe(want);
  });

  it('is empty for a missing or broken date', () => {
    expect(lastOpened('', now, 'en')).toBeNull();
    expect(lastOpened('not a date', now, 'en')).toBeNull();
  });
});
