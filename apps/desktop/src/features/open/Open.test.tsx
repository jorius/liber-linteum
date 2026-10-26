import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TreeNode, VaultInfo } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { usePageStore } from '../../stores/pageStore';
import { childrenByParent } from '../../stores/tree';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { ExplorerTree } from '../explorer/ExplorerTree';
import { useScratchpadStore } from '../scratchpad/scratchpadStore';
import { useOpenStore } from './openStore';

const nodes: TreeNode[] = [
  { path: 'Scratchpad', kind: 'folder' },
  { path: 'Scratchpad/q.md', kind: 'page' },
  { path: 'Art', kind: 'folder', icon: '🎨' },
  { path: 'Art/rex.md', kind: 'page' },
  { path: 'Welcome.md', kind: 'page' },
  { path: 'Zed.md', kind: 'page' },
  { path: '.trash/Old.md', kind: 'page' },
];

const info = { name: 'v', root: '/v' } as VaultInfo;

/** Opens a vault whose Rust side keeps `open` as its Open list (and
 *  `favorites`); the page store's load just shows the page. */
async function vault(open: string[], favorites: string[] = []) {
  let stored = open;
  const sets: string[][] = [];
  mockIPC((cmd, args) => {
    if (cmd === 'open_get') return stored;
    if (cmd === 'open_set') {
      stored = (args as { paths: string[] }).paths;
      sets.push(stored);
      return stored;
    }
    if (cmd === 'favorites_get') return favorites;
    return null;
  });
  const load = vi.spyOn(usePageStore.getState(), 'load').mockImplementation(async (path) => {
    usePageStore.setState({ state: 'ready', path });
  });
  useScratchpadStore.setState({ folder: 'Scratchpad' });
  useVaultStore.setState({
    status: 'open',
    info,
    nodes,
    children: childrenByParent(nodes),
    expanded: new Set(),
    selected: null,
    renaming: null,
  });
  await waitFor(() => expect(useOpenStore.getState().paths).toEqual(open));
  return { sets, load };
}

afterEach(async () => {
  vi.restoreAllMocks();
  usePageStore.getState().clear();
  await resetVaultStore();
  useScratchpadStore.setState({ folder: null });
  clearMocks();
});

const section = () => screen.getByRole('region', { name: 'Open' });
const shown = () =>
  within(section())
    .getAllByRole('listitem')
    .map((li) => li.dataset.open);

describe('the Open list (0.1.2)', () => {
  it('is hidden while nothing is open', async () => {
    await vault([]);
    render(<ExplorerTree />);
    expect(screen.queryByRole('region', { name: 'Open' })).toBeNull();
  });

  it('sits at the top, above the Scratchpad and Favorites; binned and missing entries hide', async () => {
    await vault(['Zed.md', '.trash/Old.md', 'Gone.md', 'Art', 'Art/rex.md'], ['Zed.md']);
    const { container } = render(<ExplorerTree />);
    await screen.findByRole('region', { name: 'Favorites' });
    const [quick] = screen.getAllByRole('tree');
    expect(
      section().compareDocumentPosition(quick) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(shown()).toEqual(['Zed.md', 'Art/rex.md']);
    const results = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('a page shown in the editor joins it, once', async () => {
    const { sets } = await vault(['Zed.md']);
    usePageStore.setState({ state: 'ready', path: 'Welcome.md' });
    await waitFor(() => expect(sets.at(-1)).toEqual(['Zed.md', 'Welcome.md']));
    usePageStore.setState({ state: 'ready', path: 'Zed.md' });
    usePageStore.setState({ state: 'ready', path: 'Welcome.md' });
    await waitFor(() => expect(useOpenStore.getState().paths).toEqual(['Zed.md', 'Welcome.md']));
    expect(sets).toHaveLength(1);
  });

  it('a click goes back to one; × closes it, and the page on screen gives way to its neighbour', async () => {
    const { sets, load } = await vault(['Zed.md', 'Welcome.md', 'Art/rex.md']);
    render(<ExplorerTree />);
    await userEvent.click(within(section()).getByRole('button', { name: 'Welcome' }));
    expect(load).toHaveBeenCalledWith('Welcome.md');
    expect(within(section()).getByRole('button', { name: 'Welcome' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await userEvent.click(within(section()).getByRole('button', { name: 'Close Welcome' }));
    await waitFor(() => expect(sets.at(-1)).toEqual(['Zed.md', 'Art/rex.md']));
    expect(usePageStore.getState().path).toBe('Art/rex.md');
    // Not the page on screen: it just leaves the list.
    await userEvent.click(within(section()).getByRole('button', { name: 'Close Zed' }));
    await waitFor(() => expect(sets.at(-1)).toEqual(['Art/rex.md']));
    expect(usePageStore.getState().path).toBe('Art/rex.md');
    // The last one closes the page.
    within(section()).getByRole('button', { name: 'rex' }).focus();
    await userEvent.keyboard('{Delete}');
    await waitFor(() => expect(sets.at(-1)).toEqual([]));
    expect(usePageStore.getState().path).toBeNull();
    expect(screen.queryByRole('region', { name: 'Open' })).toBeNull();
  });

  it('Close all empties it and closes the page on screen', async () => {
    const { sets } = await vault(['Zed.md', 'Welcome.md']);
    usePageStore.setState({ state: 'ready', path: 'Zed.md' });
    render(<ExplorerTree />);
    await userEvent.click(within(section()).getByRole('button', { name: 'Close all' }));
    await waitFor(() => expect(sets.at(-1)).toEqual([]));
    expect(usePageStore.getState().path).toBeNull();
  });

  it('the heading folds it', async () => {
    await vault(['Zed.md']);
    render(<ExplorerTree />);
    const heading = within(section()).getByRole('button', { name: 'Open' });
    await userEvent.click(heading);
    expect(heading).toHaveAttribute('aria-expanded', 'false');
    expect(within(section()).queryByRole('list')).toBeNull();
  });
});
