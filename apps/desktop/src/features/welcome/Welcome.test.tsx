import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
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
  it('shows the app name, tagline, the vault actions and Notion as later', () => {
    backend({ vaults_recent: () => [] });
    render(<Welcome version="0.1.0" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Notes In My Way' })).toBeInTheDocument();
    expect(screen.getByText(/Private notes that live on your disk/)).toBeInTheDocument();
    for (const name of ['Create a new vault', 'Open a folder as vault', 'Open an Obsidian vault']) {
      expect(screen.getByRole('button', { name })).toBeEnabled();
    }
    const notion = screen.getByRole('button', { name: 'Import a Notion export' });
    expect(notion).toBeDisabled();
    expect(notion).toHaveAccessibleDescription('Notion import arrives in a later milestone.');
    expect(screen.getByText('v0.1.0')).toBeInTheDocument();
  });

  it('VLT-01 create picks a folder and creates the vault', async () => {
    const calls = backend({
      vaults_recent: () => [],
      'plugin:dialog|open': () => '/v/Notes',
      vault_create: () => info,
      vault_tree: () => [],
    });
    render(<Welcome version={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Create a new vault' }));
    await waitFor(() => expect(useVaultStore.getState().status).toBe('open'));
    expect(calls.find(([c]) => c === 'vault_create')?.[1]).toEqual({ path: '/v/Notes' });
  });

  it.each(['Open a folder as vault', 'Open an Obsidian vault'])(
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
    await userEvent.click(screen.getByRole('button', { name: 'Open a folder as vault' }));
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
    const list = await screen.findByRole('list', { name: 'Recent' });
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
    await screen.findByRole('list', { name: 'Recent' });
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
