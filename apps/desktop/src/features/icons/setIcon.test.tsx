import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { resetEditorStore, useEditorStore } from '../../stores/editorStore';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { fakeDisk } from '../../test/fakeDisk';
import { PageScreen } from '../../test/pageScreen';
import { setIcon } from './setIcon';

const iconOf = (path: string) => useVaultStore.getState().nodes.find((n) => n.path === path)?.icon;

beforeEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useVaultStore.setState({ info: { name: 'Vault', root: '/v', report: {} as never } });
});
afterEach(async () => {
  usePageStore.getState().clear();
  resetEditorStore();
  await resetVaultStore();
  clearMocks();
});

describe('setting an icon (M5b §4)', () => {
  it('writes an open page’s frontmatter through its document and shows it at once', async () => {
    const disk = fakeDisk({ 'A.md': '# A\n\nText.\n' });
    await act(() => useVaultStore.getState().refreshTree());
    render(<PageScreen />);
    await act(() => usePageStore.getState().load('A.md'));
    await act(async () => {
      expect(await setIcon({ kind: 'page', path: 'A.md' }, '🚀')).toBe(true);
    });
    expect(iconOf('A.md')).toBe('🚀');
    await act(() => useEditorStore.getState().saveAll());
    expect(disk.files.get('A.md')).toBe('---\nicon: 🚀\n---\n# A\n\nText.\n');
  });

  it('writes a page that isn’t open by compare-and-swap, keeping its bytes', async () => {
    const disk = fakeDisk({ 'B.md': '---\r\ntags: [x]\r\n---\r\n# B\r\n' });
    await act(() => useVaultStore.getState().refreshTree());
    await act(async () => {
      expect(await setIcon({ kind: 'page', path: 'B.md' }, '🐉')).toBe(true);
    });
    expect(disk.files.get('B.md')).toBe('---\r\ntags: [x]\r\nicon: 🐉\r\n---\r\n# B\r\n');
    expect(iconOf('B.md')).toBe('🐉');
    await act(async () => {
      await setIcon({ kind: 'page', path: 'B.md' }, null);
    });
    expect(disk.files.get('B.md')).toBe('---\r\ntags: [x]\r\n---\r\n# B\r\n');
    expect(iconOf('B.md')).toBeUndefined();
  });

  it('the header’s icon button picks one for the open page', async () => {
    const disk = fakeDisk({ 'A.md': '---\nicon: 🚀\n---\n# A\n' });
    await act(() => useVaultStore.getState().refreshTree());
    render(<PageScreen />);
    await act(() => usePageStore.getState().load('A.md'));
    const button = await screen.findByRole('button', { name: 'Change icon' });
    expect(button).toHaveTextContent('🚀');
    await userEvent.click(button);
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Search emoji' }), 'dragon');
    await waitFor(() => expect(screen.getAllByRole('gridcell')[0]).toHaveAccessibleName('dragon'));
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(button).toHaveTextContent('🐉'));
    expect(button).toHaveFocus();
    await act(() => useEditorStore.getState().saveAll());
    expect(disk.files.get('A.md')).toBe('---\nicon: 🐉\n---\n# A\n');
  });

  it('sets folder and vault icons through their commands', async () => {
    const disk = fakeDisk(
      { 'Lore/A.md': '# A\n' },
      { folder_icon_set: () => null, vault_icon_set: () => null },
    );
    useVaultStore.setState({
      nodes: [
        { path: 'Lore', kind: 'folder' },
        { path: 'Lore/A.md', kind: 'page' },
      ],
    });
    await act(async () => {
      await setIcon({ kind: 'folder', path: 'Lore' }, '🐉');
      await setIcon({ kind: 'vault' }, '🌌');
    });
    expect(disk.calls).toContainEqual(['folder_icon_set', { path: 'Lore', icon: '🐉' }]);
    expect(disk.calls).toContainEqual(['vault_icon_set', { icon: '🌌' }]);
    expect(iconOf('Lore')).toBe('🐉');
    expect(useVaultStore.getState().children.get('')?.[0]?.icon).toBe('🐉');
    expect(useVaultStore.getState().info?.icon).toBe('🌌');
  });
});
