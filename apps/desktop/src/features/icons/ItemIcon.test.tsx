import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TreeNode } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { childrenByParent } from '../../stores/tree';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { ExplorerTree } from '../explorer/ExplorerTree';
import { Breadcrumb } from '../page/Breadcrumb';
import { Sidebar } from '../shell/Sidebar';
import { RecentList } from '../welcome/RecentList';

const nodes: TreeNode[] = [
  { path: 'Lore', kind: 'folder', icon: '🐉' },
  { path: 'Lore/Maps.md', kind: 'page', icon: '🗺️' },
  { path: 'Plain.md', kind: 'page' },
];

beforeEach(() => {
  useVaultStore.setState({
    status: 'open',
    info: { name: 'Dark Galaxy', root: '/v', report: {} as never, icon: '🌌' },
    nodes,
    children: childrenByParent(nodes),
    expanded: new Set(['Lore']),
  });
});
afterEach(async () => {
  await resetVaultStore();
  clearMocks();
});

describe('icons where names show (M5b §4)', () => {
  it('rows show a page’s emoji in place of its glyph, a folder’s after its chevron, nothing otherwise', () => {
    render(<ExplorerTree />);
    const row = (name: string) => screen.getByRole('treeitem', { name });
    expect(row('Maps')).toHaveTextContent('🗺️Maps');
    expect(row('Maps').querySelector('svg')).toBeNull();
    expect(row('Lore')).toHaveTextContent('🐉Lore');
    expect(row('Lore').querySelector('svg')).not.toBeNull();
    expect(row('Plain')).toHaveTextContent(/^Plain/);
  });

  it('the breadcrumb shows the vault’s, folders’ and the page’s emoji', () => {
    render(<Breadcrumb path="Lore/Maps.md" />);
    const crumbs = within(screen.getByRole('navigation')).getAllByRole('listitem');
    expect(crumbs.map((c) => c.textContent)).toEqual(['🌌Dark Galaxy', '🐉Lore', '🗺️Maps']);
  });

  it('the sidebar shows the vault’s emoji as a button that opens the picker', async () => {
    render(<Sidebar />);
    const button = screen.getByRole('button', { name: 'Change icon' });
    expect(button).toHaveTextContent('🌌');
    await userEvent.click(button);
    expect(await screen.findByRole('dialog', { name: 'Icon for Dark Galaxy' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(button).toHaveFocus();
  });

  it('a vault with no icon offers Add icon', () => {
    act(() => useVaultStore.setState({ info: { name: 'V', root: '/v', report: {} as never } }));
    render(<Sidebar />);
    expect(screen.getByRole('button', { name: 'Add icon' })).toBeInTheDocument();
  });

  it('recent vaults show their emoji', async () => {
    mockIPC((cmd) =>
      cmd === 'vaults_recent'
        ? [
            { path: '/a', name: 'Dark Galaxy', openedAt: '', missing: false, icon: '🌌' },
            { path: '/b', name: 'Plain', openedAt: '', missing: false },
          ]
        : null,
    );
    render(<RecentList />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    const [a, b] = screen.getAllByRole('listitem');
    expect(a).toHaveTextContent('🌌');
    expect(b).not.toHaveTextContent('🌌');
  });
});
