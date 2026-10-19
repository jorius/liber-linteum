import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TreeNode, VaultInfo } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { usePageStore } from '../../stores/pageStore';
import { childrenByParent } from '../../stores/tree';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { ContextMenu } from '../explorer/ContextMenu';
import { ExplorerTree } from '../explorer/ExplorerTree';
import { useScratchpadStore } from '../scratchpad/scratchpadStore';
import { useGlobalShortcuts } from '../shell/useGlobalShortcuts';
import { useUiStore } from '../../stores/uiStore';
import { FavoriteToggle } from './FavoriteToggle';
import { useFavoritesStore } from './favoritesStore';

const nodes: TreeNode[] = [
  { path: 'Scratchpad', kind: 'folder' },
  { path: 'Scratchpad/q.md', kind: 'page' },
  { path: 'Art', kind: 'folder', icon: '🎨' },
  { path: 'Art/rex.md', kind: 'page' },
  { path: 'Games', kind: 'folder' },
  { path: 'Welcome.md', kind: 'page' },
  { path: 'Zed.md', kind: 'page' },
];

const info = { name: 'v', root: '/v' } as VaultInfo;

/** Opens a vault whose Rust side keeps `favorites`. */
async function open(favorites: string[]) {
  let stored = favorites;
  const sets: string[][] = [];
  mockIPC((cmd, args) => {
    if (cmd === 'favorites_get') return stored;
    if (cmd === 'favorites_set') {
      stored = (args as { paths: string[] }).paths;
      sets.push(stored);
      return stored;
    }
    return null;
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
  await waitFor(() => expect(useFavoritesStore.getState().paths).toEqual(favorites));
  return sets;
}

afterEach(async () => {
  await resetVaultStore();
  useScratchpadStore.setState({ folder: null });
  usePageStore.getState().clear();
  clearMocks();
  try {
    localStorage.clear();
  } catch {
    // jsdom always has it
  }
});

const section = () => screen.getByRole('region', { name: 'Favorites' });

describe('Favorites (M5b §19)', () => {
  it('is hidden while there are none', async () => {
    await open([]);
    render(<ExplorerTree />);
    expect(screen.queryByRole('region', { name: 'Favorites' })).toBeNull();
    expect(screen.getAllByRole('tree')).toHaveLength(1);
  });

  it('sits under the pinned Scratchpad, between the tree halves, in order', async () => {
    await open(['Zed.md', 'Art', 'Gone.md']);
    render(<ExplorerTree />);
    const [quick, files] = screen.getAllByRole('tree');
    expect(quick).toHaveAccessibleName('Quick notes');
    expect(files).toHaveAccessibleName('Files');
    expect(
      within(quick)
        .getAllByRole('treeitem')
        .map((r) => r.dataset.name),
    ).toEqual(['Scratchpad']);
    // DOM order: quick notes, Favorites, the rest of the files.
    expect(
      quick.compareDocumentPosition(section()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      section().compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Missing entries are skipped; the folder's emoji shows.
    const list = within(section()).getByRole('list');
    expect(
      within(list)
        .getAllByRole('button', { name: /^(Zed|Art)$/ })
        .map((b) => b.textContent),
    ).toEqual(['Zed', 'Art']);
    expect(within(list).getByText('🎨')).toBeInTheDocument();
  });

  it('opens a page, and a folder in place', async () => {
    await open(['Art', 'Welcome.md']);
    const load = vi.spyOn(usePageStore.getState(), 'load').mockResolvedValue(undefined);
    render(<ExplorerTree />);
    await userEvent.click(within(section()).getByRole('button', { name: 'Welcome' }));
    expect(load).toHaveBeenCalledWith('Welcome.md');
    const art = within(section()).getByRole('button', { name: 'Art' });
    expect(art).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(art);
    expect(art).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(within(section()).getByRole('button', { name: 'rex' }));
    expect(load).toHaveBeenCalledWith('Art/rex.md');
  });

  it('the star takes one out; the heading collapses, remembered per vault', async () => {
    const sets = await open(['Zed.md', 'Welcome.md']);
    const { unmount } = render(<ExplorerTree />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Zed from Favorites' }));
    expect(sets.at(-1)).toEqual(['Welcome.md']);
    const heading = within(section()).getByRole('button', { name: 'Favorites' });
    await userEvent.click(heading);
    expect(heading).toHaveAttribute('aria-expanded', 'false');
    expect(within(section()).queryByRole('list')).toBeNull();
    unmount();
    render(<ExplorerTree />);
    expect(within(section()).getByRole('button', { name: 'Favorites' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('the row menu adds, removes and moves favorites', async () => {
    const sets = await open(['Zed.md', 'Welcome.md']);
    const close = vi.fn();
    const { unmount } = render(
      <ContextMenu menu={{ path: 'Games', anchor: { x: 0, y: 0 } }} onClose={close} />,
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Add to Favorites' }));
    expect(sets.at(-1)).toEqual(['Zed.md', 'Welcome.md', 'Games']);
    unmount();
    render(<ContextMenu menu={{ path: 'Welcome.md', anchor: { x: 0, y: 0 } }} onClose={close} />);
    expect(screen.getByRole('menuitem', { name: 'Remove from Favorites' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Move up in Favorites' }));
    expect(sets.at(-1)).toEqual(['Welcome.md', 'Zed.md', 'Games']);
    expect(screen.queryByRole('menuitem', { name: 'Move down in Favorites' })).toBeInTheDocument();
  });

  it('the header star toggles the page, pressed while it is a favorite', async () => {
    const sets = await open(['Zed.md']);
    render(<FavoriteToggle path="Welcome.md" />);
    const star = screen.getByRole('button', { name: 'Add to Favorites' });
    expect(star).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(star);
    expect(sets.at(-1)).toEqual(['Zed.md', 'Welcome.md']);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove from Favorites' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
  });

  it('⌘⇧D / Ctrl+Shift+D toggles the open page, in the editor only', async () => {
    const sets = await open([]);
    usePageStore.setState({ state: 'ready', path: 'Welcome.md' });
    useUiStore.getState().setScreen('edit');
    renderHook(() => useGlobalShortcuts(false));
    await userEvent.keyboard('{Control>}{Shift>}D{/Shift}{/Control}');
    expect(sets.at(-1)).toEqual(['Welcome.md']);
    useUiStore.getState().setScreen('global');
    await userEvent.keyboard('{Control>}{Shift>}D{/Shift}{/Control}');
    expect(sets).toHaveLength(1);
  });

  it('round-2 review M6, M7: ⌘⇧D needs the D key itself (Dvorak E stays E), and a page', async () => {
    const sets = await open([]);
    useUiStore.getState().setScreen('edit');
    renderHook(() => useGlobalShortcuts(false));
    // Dvorak: the key labelled E sits where QWERTY's D is.
    usePageStore.setState({ state: 'ready', path: 'Welcome.md' });
    fireEvent.keyDown(window, {
      key: 'E',
      code: 'KeyD',
      ctrlKey: true,
      metaKey: true,
      shiftKey: true,
    });
    expect(sets).toHaveLength(0);
    // A text file open in the editor isn't a page Favorites can show.
    useVaultStore.setState({ nodes: [...nodes, { path: 'data.csv', kind: 'attachment' }] });
    usePageStore.setState({ state: 'ready', path: 'data.csv' });
    fireEvent.keyDown(window, {
      key: 'D',
      code: 'KeyD',
      ctrlKey: true,
      metaKey: true,
      shiftKey: true,
    });
    expect(sets).toHaveLength(0);
  });

  it('round-2 review M8: saves run one at a time, each from the list Rust holds now', async () => {
    await open([]);
    let stored = ['Old.md']; // Rust renamed Welcome.md → Old.md meanwhile; the store hasn't reloaded
    let first = true;
    mockIPC(async (cmd, args) => {
      if (cmd === 'favorites_get') return stored;
      if (cmd === 'favorites_set') {
        const paths = (args as { paths: string[] }).paths;
        if (first) {
          first = false;
          await new Promise((r) => setTimeout(r, 30)); // the first save lands last
        }
        stored = paths.filter((p) => p !== 'Welcome.md'); // Rust drops what's gone
        return stored;
      }
      return null;
    });
    useFavoritesStore.setState({ paths: ['Welcome.md'] });
    await Promise.all([
      useFavoritesStore.getState().toggle('Zed.md'),
      useFavoritesStore.getState().toggle('Art'),
    ]);
    expect(stored).toEqual(['Old.md', 'Zed.md', 'Art']);
  });

  it('round-2 review M10: a cancelled or Escaped drag moves nothing; Move up says where it went', async () => {
    const sets = await open(['Zed.md', 'Welcome.md']);
    render(<ExplorerTree />);
    const row = section().querySelector('[data-favorite="Welcome.md"] > div') as HTMLElement;
    fireEvent.pointerDown(row, { button: 0, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(row, { clientY: 10, pointerId: 1 });
    fireEvent.pointerCancel(row, { pointerId: 1 });
    fireEvent.pointerUp(row, { clientY: 10, pointerId: 1 });
    fireEvent.pointerDown(row, { button: 0, clientY: 100, pointerId: 2 });
    fireEvent.pointerMove(row, { clientY: 10, pointerId: 2 });
    fireEvent.keyDown(row, { key: 'Escape' });
    fireEvent.pointerUp(row, { clientY: 10, pointerId: 2 });
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(sets).toEqual([]);
    expect(section().querySelector('[class*="dropAbove"]')).toBeNull();
    const close = vi.fn();
    render(<ContextMenu menu={{ path: 'Welcome.md', anchor: { x: 0, y: 0 } }} onClose={close} />);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Move up in Favorites' }));
    expect(document.querySelector('[data-nimw-status]')).toHaveTextContent(
      'Welcome moved to 1 of 2 in Favorites',
    );
  });

  it('has no axe violations', async () => {
    await open(['Art', 'Welcome.md']);
    const { container } = render(<ExplorerTree />);
    const result = await act(() => axe.run(container));
    expect(result.violations).toEqual([]);
  });
});
