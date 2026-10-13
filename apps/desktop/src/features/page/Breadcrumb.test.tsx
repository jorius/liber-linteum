import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TreeNode } from '../../ipc';
import { childrenByParent } from '../../stores/tree';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { ExplorerTree } from '../explorer/ExplorerTree';
import { Breadcrumb } from './Breadcrumb';

const nodes: TreeNode[] = [
  { path: 'Art', kind: 'folder' },
  { path: 'Art/Sketches', kind: 'folder' },
  { path: 'Art/Sketches/rex.md', kind: 'page' },
  { path: 'b.md', kind: 'page' },
];

beforeEach(() =>
  act(() =>
    useVaultStore.setState({
      status: 'open',
      info: { name: 'My Vault', root: '/v', report: {} as never },
      nodes,
      children: childrenByParent(nodes),
      expanded: new Set(),
    }),
  ),
);
afterEach(() => resetVaultStore());

describe('Breadcrumb (M2a §5)', () => {
  it('lists the vault, each folder and the current page', () => {
    render(<Breadcrumb path="Art/Sketches/rex.md" />);
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    const items = [...nav.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toEqual(['My Vault', 'Art', 'Sketches', 'rex']);
    expect(screen.getByText('rex')).toHaveAttribute('aria-current', 'page');
  });

  it('a folder segment expands its chain in the explorer and focuses it', async () => {
    render(
      <>
        <Breadcrumb path="Art/Sketches/rex.md" />
        <ExplorerTree />
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sketches' }));
    expect(useVaultStore.getState().expanded).toEqual(new Set(['Art', 'Art/Sketches']));
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: 'Sketches' }));
  });

  it('the vault segment collapses the tree to the top and focuses it', async () => {
    act(() => useVaultStore.setState({ expanded: new Set(['Art', 'Art/Sketches']) }));
    render(
      <>
        <Breadcrumb path="Art/Sketches/rex.md" />
        <ExplorerTree />
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'My Vault' }));
    expect(useVaultStore.getState().expanded.size).toBe(0);
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: 'Art' }));
  });
});
