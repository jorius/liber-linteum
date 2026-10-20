import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TreeNode } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { childrenByParent } from '../../stores/tree';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog';

function seed(nodes: TreeNode[]) {
  useVaultStore.setState({ status: 'open', nodes, children: childrenByParent(nodes) });
}

afterEach(async () => {
  await resetVaultStore();
  clearMocks();
});

describe('ConfirmDeleteDialog', () => {
  it('round 3b §6.3: a folder with its own page says the page goes with it', async () => {
    mockIPC((cmd) => (cmd === 'backlink_count' ? 0 : null));
    seed([
      { path: 'Lore', kind: 'folder' },
      { path: 'Lore/Lore.md', kind: 'page' },
      { path: 'Lore/Other.md', kind: 'page' },
    ]);
    render(<ConfirmDeleteDialog path="Lore" onClose={() => {}} />);
    expect(await screen.findByText('Its page, Lore, goes with it.')).toBeInTheDocument();
  });

  it('a folder without one says nothing about it', async () => {
    mockIPC((cmd) => (cmd === 'backlink_count' ? 0 : null));
    seed([
      { path: 'Lore', kind: 'folder' },
      { path: 'Lore/Other.md', kind: 'page' },
    ]);
    render(<ConfirmDeleteDialog path="Lore" onClose={() => {}} />);
    await screen.findByText('Nothing links to it.');
    expect(screen.queryByText(/goes with it/)).toBeNull();
  });
});
