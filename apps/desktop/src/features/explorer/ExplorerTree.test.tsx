import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TreeNode } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { usePageStore } from '../../stores/pageStore';
import { useUiStore } from '../../stores/uiStore';
import { childrenByParent } from '../../stores/tree';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { useFavoritesStore } from '../favorites/favoritesStore';
import { useScratchpadStore } from '../scratchpad/scratchpadStore';
import { ContextMenu } from './ContextMenu';
import { ExplorerTree, visibleRows } from './ExplorerTree';

const nodes: TreeNode[] = [
  { path: 'Art', kind: 'folder' },
  { path: 'Art/DMC', kind: 'folder' },
  { path: 'Art/DMC/Sparda.md', kind: 'page' },
  { path: 'Art/rex.md', kind: 'page' },
  { path: 'Art/cover.png', kind: 'attachment' },
  { path: 'Games', kind: 'folder' },
  { path: 'Welcome.md', kind: 'page' },
];

function seed(
  list: TreeNode[] = nodes,
  extra: Partial<ReturnType<typeof useVaultStore.getState>> = {},
) {
  useVaultStore.setState({
    status: 'open',
    nodes: list,
    children: childrenByParent(list),
    expanded: new Set(),
    selected: null,
    renaming: null,
    ...extra,
  });
}

function backend(handlers: Record<string, (a: Record<string, unknown>) => unknown>) {
  const calls: [string, Record<string, unknown>][] = [];
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push([cmd, a]);
    return handlers[cmd]?.(a);
  });
  return calls;
}

const items = () => screen.getAllByRole('treeitem');
const names = () => items().map((i) => i.getAttribute('data-name'));

afterEach(async () => {
  await resetVaultStore();
  usePageStore.getState().clear();
  clearMocks();
});

describe('ExplorerTree (EXP-01, NFR-10)', () => {
  it('is an ARIA tree with levels, expansion, selection and a single Tab stop', () => {
    seed(nodes, { expanded: new Set(['Art']), selected: 'Art/rex.md' });
    render(<ExplorerTree />);
    const tree = screen.getByRole('tree', { name: 'Files' });
    expect(names()).toEqual(['Art', 'DMC', 'rex', 'cover.png', 'Games', 'Welcome']);
    const art = within(tree).getByRole('treeitem', { name: 'Art' });
    expect(art).toHaveAttribute('aria-level', '1');
    expect(art).toHaveAttribute('aria-expanded', 'true');
    const rex = within(tree).getByRole('treeitem', { name: 'rex' });
    expect(rex).toHaveAttribute('aria-level', '2');
    expect(rex).toHaveAttribute('aria-selected', 'true');
    expect(rex).not.toHaveAttribute('aria-expanded');
    expect(items().filter((i) => i.tabIndex === 0)).toEqual([rex]);
  });

  it('arrow keys move, expand and collapse; Home/End jump', async () => {
    seed();
    render(<ExplorerTree />);
    items()[0].focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(useVaultStore.getState().expanded.has('Art')).toBe(true);
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toHaveAttribute('data-name', 'DMC');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toHaveAttribute('data-name', 'cover.png');
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toHaveAttribute('data-name', 'Art');
    await userEvent.keyboard('{ArrowLeft}');
    expect(useVaultStore.getState().expanded.has('Art')).toBe(false);
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toHaveAttribute('data-name', 'Welcome');
    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toHaveAttribute('data-name', 'Art');
  });

  it('type-ahead focuses the next item starting with the typed letter', async () => {
    seed();
    render(<ExplorerTree />);
    items()[0].focus();
    await userEvent.keyboard('w');
    expect(document.activeElement).toHaveAttribute('data-name', 'Welcome');
    await userEvent.keyboard('g');
    expect(document.activeElement).toHaveAttribute('data-name', 'Games');
  });

  it('EXP-05 Enter or click on a page selects it and opens the page view', async () => {
    backend({
      page_get: (a) => ({
        path: a.path,
        title: 'Welcome',
        tags: [],
        text: '',
        links: 0,
        backlinks: 0,
      }),
    });
    seed();
    render(<ExplorerTree />);
    screen.getByRole('treeitem', { name: 'Welcome' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(useVaultStore.getState().selected).toBe('Welcome.md');
    await waitFor(() => expect(usePageStore.getState().state).toBe('ready'));
    await userEvent.click(screen.getByRole('treeitem', { name: 'Games' }));
    expect(useVaultStore.getState().expanded.has('Games')).toBe(true);
    expect(useVaultStore.getState().selected).toBe('Games');
  });

  it('M4b part 2 §6: a text or code file opens in the app; other files only select', async () => {
    const calls = backend({ text_read: () => ({ text: '{}', hash: 'h' }) });
    const list: TreeNode[] = [...nodes, { path: 'app.json', kind: 'attachment' }];
    seed(list, { expanded: new Set(['Art']) });
    render(<ExplorerTree />);
    await userEvent.click(screen.getByRole('treeitem', { name: 'app.json' }));
    await waitFor(() => expect(usePageStore.getState().path).toBe('app.json'));
    expect(calls).toContainEqual(['text_read', { path: 'app.json' }]);
    await userEvent.click(screen.getByRole('treeitem', { name: 'cover.png' }));
    expect(useVaultStore.getState().selected).toBe('Art/cover.png');
    expect(usePageStore.getState().path).toBe('app.json');
  });

  it('EXP-02 F2 renames inline, validating the name as you type', async () => {
    const calls = backend({
      entry_rename: () => ({ moved: [], updatedFiles: [], updatedLinks: 0, failed: [] }),
      vault_tree: () => nodes,
    });
    seed();
    render(<ExplorerTree />);
    screen.getByRole('treeitem', { name: 'Welcome' }).focus();
    await userEvent.keyboard('{F2}');
    const input = screen.getByRole('textbox', { name: 'Rename' });
    expect(input).toHaveValue('Welcome');
    await userEvent.clear(input);
    await userEvent.type(input, 'C# notes');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Names can\'t contain "#".');
    await userEvent.keyboard('{Enter}');
    expect(calls.map(([c]) => c)).not.toContain('entry_rename');
    await userEvent.clear(input);
    await userEvent.type(input, 'Start here{Enter}');
    await waitFor(() =>
      expect(calls.find(([c]) => c === 'entry_rename')?.[1]).toEqual({
        from: 'Welcome.md',
        to: 'Start here.md',
      }),
    );
  });

  it('Escape cancels an inline rename without calling the backend', async () => {
    const calls = backend({});
    seed(nodes, { renaming: 'Art/rex.md', expanded: new Set(['Art']) });
    render(<ExplorerTree />);
    const input = screen.getByRole('textbox', { name: 'Rename' });
    await userEvent.type(input, 'x{Escape}');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(calls).toEqual([]);
    expect(useVaultStore.getState().renaming).toBeNull();
  });

  it('EXP-02 a new page appears in inline rename with its name selected', async () => {
    let current = nodes;
    backend({
      vault_tree: () => current,
      entry_create_page: (a) => {
        const path = `${a.dir}/${a.name}.md`;
        current = [...current, { path, kind: 'page' }];
        return path;
      },
    });
    seed();
    render(<ExplorerTree />);
    await act(async () => {
      await useVaultStore.getState().createPage('Games');
    });
    const input = await screen.findByRole('textbox', { name: 'Rename' });
    expect(input).toHaveValue('Untitled');
    expect(input).toHaveFocus();
    expect((input as HTMLInputElement).selectionStart).toBe(0);
    expect((input as HTMLInputElement).selectionEnd).toBe('Untitled'.length);
  });

  it('Delete asks the owner to delete the focused item', async () => {
    const onRequestDelete = vi.fn();
    seed();
    render(<ExplorerTree onRequestDelete={onRequestDelete} />);
    screen.getByRole('treeitem', { name: 'Games' }).focus();
    await userEvent.keyboard('{Delete}');
    expect(onRequestDelete).toHaveBeenCalledWith('Games');
  });

  /** Review Focus: a vault with thousands of files in a collapsed folder renders
   * only what is visible, so refreshing the tree stays cheap. */
  it('review_focus renders only rows of expanded folders', () => {
    const many: TreeNode[] = [
      { path: 'Big', kind: 'folder' },
      ...Array.from({ length: 5000 }, (_, i) => ({ path: `Big/n${i}.md`, kind: 'page' as const })),
      { path: 'a.md', kind: 'page' },
    ];
    seed(many);
    render(<ExplorerTree />);
    expect(items()).toHaveLength(2);
  });

  it('NFR-10 has no axe violations', async () => {
    seed(nodes, { expanded: new Set(['Art']), selected: 'Art/rex.md' });
    const { container } = render(<ExplorerTree />);
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});

describe('the pinned scratch folder (M4c §7.2)', () => {
  const withScratch: TreeNode[] = [
    { path: 'Art', kind: 'folder' },
    { path: 'Art/rex.md', kind: 'page' },
    { path: 'Scratchpad', kind: 'folder' },
    { path: 'Scratchpad/Idea.md', kind: 'page' },
    { path: 'Scratchpad/Old', kind: 'folder' },
    { path: 'Scratchpad/Old/Trip.md', kind: 'page' },
    { path: 'Scratchpad/sketch.png', kind: 'attachment' },
    { path: 'Welcome.md', kind: 'page' },
  ];

  afterEach(() => useScratchpadStore.getState().reset());

  it('visibleRows puts it first; nothing changes without it', () => {
    const children = childrenByParent(withScratch);
    const rows = (pinned: string | null) =>
      visibleRows(children, new Set(['Scratchpad']), pinned).map((r) => r.node.path);
    expect(rows('Scratchpad').slice(0, 4)).toEqual([
      'Scratchpad',
      'Scratchpad/Idea.md',
      'Scratchpad/Old',
      'Scratchpad/sketch.png',
    ]);
    expect(rows('Scratchpad').slice(4)).toEqual(['Art', 'Welcome.md']);
    expect(rows(null)[0]).toBe('Art');
    expect(rows('Missing')[0]).toBe('Art');
  });

  it('is first, with its note count, a pencil and a divider under it', () => {
    useScratchpadStore.setState({ folder: 'Scratchpad' });
    seed(withScratch);
    render(<ExplorerTree />);
    const items = screen.getAllByRole('treeitem');
    expect(items[0]).toHaveAccessibleName('Scratchpad, quick notes, 2 notes');
    expect(items[0].querySelector('[data-quick-note-icon]')).not.toBeNull();
    expect(within(items[0]).getByText('2')).toBeInTheDocument();
    expect(items[1]).toHaveAttribute('data-path', 'Art');
    expect(items[1]).toHaveAttribute('data-divider');
  });

  it('is an ordinary folder in the global Scratchpad (no folder pinned)', () => {
    seed(withScratch);
    render(<ExplorerTree />);
    expect(screen.getAllByRole('treeitem')[0]).toHaveAttribute('data-path', 'Art');
    expect(screen.getByRole('treeitem', { name: 'Scratchpad' })).toBeInTheDocument();
  });
});

describe('folder pages (round 3b §6.2)', () => {
  it("a folder's own page isn't listed under it", () => {
    const children = childrenByParent([
      { path: 'Lore', kind: 'folder' },
      { path: 'Lore/Lore.md', kind: 'page' },
      { path: 'Lore/Other.md', kind: 'page' },
      { path: 'Lore.md', kind: 'page' },
    ]);
    expect(visibleRows(children, new Set(['Lore'])).map((r) => r.node.path)).toEqual([
      'Lore',
      'Lore/Other.md',
      'Lore.md',
    ]);
  });

  const lore: TreeNode[] = [
    { path: 'Lore', kind: 'folder', icon: '📁' },
    { path: 'Lore/Lore.md', kind: 'page', icon: '🛡️' },
    { path: 'Lore/Other.md', kind: 'page' },
    { path: 'Welcome.md', kind: 'page' },
  ];
  const realLoad = usePageStore.getState().load;
  const spyLoad = () => {
    const load = vi.fn(async () => {});
    usePageStore.setState({ load });
    return load;
  };
  afterEach(() => usePageStore.setState({ load: realLoad, path: null }));
  const loreRow = () => screen.getByRole('treeitem', { name: 'Lore' });

  it('clicking the name opens the page, selects the folder and leaves it closed', async () => {
    const load = spyLoad();
    seed(lore);
    render(<ExplorerTree />);
    await userEvent.click(within(loreRow()).getByText('Lore'));
    expect(load).toHaveBeenCalledWith('Lore/Lore.md');
    expect(useVaultStore.getState().selected).toBe('Lore');
    expect(useVaultStore.getState().expanded.has('Lore')).toBe(false);
  });

  it('the chevron alone expands and collapses, and opens nothing', async () => {
    const load = spyLoad();
    seed(lore);
    render(<ExplorerTree />);
    const twisty = loreRow().querySelector('[data-twisty]')!;
    await userEvent.click(twisty);
    expect(useVaultStore.getState().expanded.has('Lore')).toBe(true);
    await userEvent.click(loreRow().querySelector('[data-twisty]')!);
    expect(useVaultStore.getState().expanded.has('Lore')).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('Enter opens the page; → and ← still expand and collapse', async () => {
    const load = spyLoad();
    seed(lore);
    render(<ExplorerTree />);
    loreRow().focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(useVaultStore.getState().expanded.has('Lore')).toBe(true);
    await userEvent.keyboard('{ArrowLeft}');
    expect(useVaultStore.getState().expanded.has('Lore')).toBe(false);
    await userEvent.keyboard('{Enter}');
    expect(load).toHaveBeenCalledWith('Lore/Lore.md');
  });

  it("shows the page's icon, else the folder's; marked current while its page is open", () => {
    seed(lore);
    usePageStore.setState({ path: 'Lore/Lore.md' });
    const { unmount } = render(<ExplorerTree />);
    expect(loreRow()).toHaveTextContent('🛡️');
    expect(loreRow()).not.toHaveTextContent('📁');
    expect(loreRow()).toHaveAttribute('aria-current', 'page');
    unmount();
    usePageStore.setState({ path: 'Welcome.md' });
    seed(lore.map((n) => (n.path === 'Lore/Lore.md' ? { ...n, icon: undefined } : n)));
    render(<ExplorerTree />);
    expect(loreRow()).toHaveTextContent('📁');
    expect(loreRow()).not.toHaveAttribute('aria-current');
  });

  it("★ on the row stars the folder's page", async () => {
    const calls = backend({ favorites_set: () => null, favorites_get: () => [] });
    useFavoritesStore.setState({ paths: [] });
    seed(lore);
    render(<ExplorerTree />);
    await userEvent.click(within(loreRow()).getByRole('button', { name: 'Lore in Favorites' }));
    expect(useFavoritesStore.getState().paths).toContain('Lore/Lore.md');
    expect(calls.some(([c]) => c === 'favorites_set')).toBe(true);
  });

  it('the pinned Scratchpad with its own page still pins first and opens it', async () => {
    const load = spyLoad();
    useScratchpadStore.setState({ folder: 'Scratchpad' });
    seed([
      { path: 'Art', kind: 'folder' },
      { path: 'Scratchpad', kind: 'folder' },
      { path: 'Scratchpad/Scratchpad.md', kind: 'page' },
    ]);
    render(<ExplorerTree />);
    expect(items()[0]).toHaveAttribute('data-path', 'Scratchpad');
    await userEvent.click(within(items()[0]).getByText('Scratchpad'));
    expect(load).toHaveBeenCalledWith('Scratchpad/Scratchpad.md');
    useScratchpadStore.getState().reset();
  });

  it('in the Archive a folder page opens its page (read-only there) and offers no ★ or ☺', async () => {
    const load = spyLoad();
    seed([
      { path: '.archive', kind: 'folder' },
      { path: '.archive/Old', kind: 'folder' },
      { path: '.archive/Old/Old.md', kind: 'page' },
    ]);
    render(<ExplorerTree root=".archive" />);
    const row = screen.getByRole('treeitem', { name: 'Old' });
    await userEvent.click(within(row).getByText('Old'));
    expect(load).toHaveBeenCalledWith('.archive/Old/Old.md');
    expect(within(row).queryByRole('button', { name: 'Old in Favorites' })).toBeNull();
  });
});

describe('row quick actions (M5b §3)', () => {
  const actions = (name: string) =>
    within(screen.getByRole('treeitem', { name }))
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));

  it('round 3 §2.3: folders and pages get ★ ☺ 🗑, attachments 🗑; no "+" or "…"; none is a Tab stop', () => {
    seed(nodes, { expanded: new Set(['Art']) });
    render(<ExplorerTree onRequestMenu={() => undefined} />);
    expect(actions('Games')).toEqual([
      'Games in Favorites',
      'Icon for Games',
      'Move Games to Trash',
    ]);
    expect(actions('Welcome')).toEqual([
      'Welcome in Favorites',
      'Icon for Welcome',
      'Move Welcome to Trash',
    ]);
    expect(actions('cover.png')).toEqual(['Move cover.png to Trash']);
    for (const b of within(screen.getByRole('tree')).getAllByRole('button')) {
      expect(b).toHaveAttribute('tabindex', '-1');
    }
  });

  it('round 3 §2.3: ★ adds the item to Favorites and fills; again takes it out', async () => {
    backend({ favorites_set: () => null, favorites_get: () => [] });
    useFavoritesStore.setState({ paths: [] });
    seed();
    render(<ExplorerTree />);
    // Review M7: one fixed name; the state is only aria-pressed (and the tooltip).
    const starOf = () =>
      within(screen.getByRole('treeitem', { name: 'Welcome' })).getByRole('button', {
        name: 'Welcome in Favorites',
      });
    expect(starOf()).toHaveAttribute('aria-pressed', 'false');
    expect(starOf()).toHaveAttribute('title', 'Add Welcome to Favorites');
    await userEvent.click(starOf());
    await waitFor(() => expect(useFavoritesStore.getState().paths).toEqual(['Welcome.md']));
    const star = starOf();
    expect(star).toHaveAttribute('aria-pressed', 'true');
    expect(star).toHaveAttribute('title', 'Remove Welcome from Favorites');
    expect(useVaultStore.getState().selected).toBeNull(); // the row wasn't activated
    await userEvent.click(star);
    await waitFor(() => expect(useFavoritesStore.getState().paths).toEqual([]));
  });

  it('round 3 §2.3: the icon action is a full-contrast glyph, not the faded smiley', () => {
    seed();
    render(<ExplorerTree />);
    const pick = screen.getByRole('button', { name: 'Icon for Games' });
    expect(pick).not.toHaveAttribute('data-empty');
    expect(pick.querySelector('svg')).not.toBeNull();
    expect(pick.textContent).not.toContain('☺');
  });

  it('🗑 asks for confirmation through the trash action', async () => {
    seed();
    render(<ExplorerTree />);
    await userEvent.click(screen.getByRole('button', { name: 'Move Welcome to Trash' }));
    expect(useUiStore.getState().dialog).toEqual({ type: 'delete', path: 'Welcome.md' });
    act(() => useUiStore.getState().closeDialog());
  });

  it('☺ opens the picker; picking sets a folder’s icon; keys in it don’t move the tree', async () => {
    const calls = backend({ folder_icon_set: () => null });
    seed();
    render(<ExplorerTree />);
    await userEvent.click(
      within(screen.getByRole('treeitem', { name: 'Games' })).getByRole('button', {
        name: 'Icon for Games',
      }),
    );
    const search = await screen.findByRole('searchbox', { name: 'Search emoji' });
    await userEvent.type(search, 'joystick');
    await waitFor(() =>
      expect(screen.getAllByRole('gridcell')[0]).toHaveAccessibleName('joystick'),
    );
    await userEvent.keyboard('{ArrowDown}{ArrowRight}{ArrowLeft}{Enter}');
    expect(calls).toContainEqual(['folder_icon_set', { path: 'Games', icon: '🕹️' }]);
    expect(useVaultStore.getState().selected).toBeNull();
  });

  it('final review M6: after the picker the keyboard is back on the row, so ↑ / ↓ move again', async () => {
    seed();
    render(<ExplorerTree />);
    const row = screen.getByRole('treeitem', { name: 'Games' });
    await userEvent.click(within(row).getByRole('button', { name: 'Icon for Games' }));
    await screen.findByRole('searchbox', { name: 'Search emoji' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(row).toHaveFocus());
  });
});

describe('the Trash view (M5b §5)', () => {
  afterEach(() => useUiStore.setState({ screen: 'edit' }));

  it('a page clicked in the files leaves the Trash view for the editor', async () => {
    backend({ page_read: () => ({ text: '# rex\n', hash: 'h' }) });
    for (const view of ['trash'] as const) {
      seed(nodes, { expanded: new Set(['Art']) });
      useUiStore.setState({ screen: view });
      render(<ExplorerTree />);
      await userEvent.click(screen.getByRole('treeitem', { name: 'rex' }));
      expect(useUiStore.getState().screen).toBe('edit');
      document.body.innerHTML = '';
    }
  });
});

describe('the row menu (M5b §3, §4)', () => {
  it('offers Icon… for pages and folders, which opens the picker in its place', async () => {
    const calls = backend({ folder_icon_set: () => null });
    seed();
    const onClose = vi.fn();
    render(<ContextMenu menu={{ path: 'Games', anchor: { x: 10, y: 10 } }} onClose={onClose} />);
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toContain('Icon…');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Icon…' }));
    const search = await screen.findByRole('searchbox', { name: 'Search emoji' });
    expect(screen.queryByRole('menu')).toBeNull();
    await userEvent.type(search, 'joystick{Enter}');
    expect(calls).toContainEqual(['folder_icon_set', { path: 'Games', icon: '🕹️' }]);
    expect(onClose).toHaveBeenCalled();
  });

  it('has no Icon… for attachments; Delete goes through the trash action', async () => {
    seed(nodes, { expanded: new Set(['Art']) });
    render(
      <ContextMenu
        menu={{ path: 'Art/cover.png', anchor: { x: 0, y: 0 } }}
        onClose={() => undefined}
      />,
    );
    expect(screen.queryByRole('menuitem', { name: 'Icon…' })).toBeNull();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(useUiStore.getState().dialog).toEqual({ type: 'delete', path: 'Art/cover.png' });
    act(() => useUiStore.getState().closeDialog());
  });
});

describe('the folder-page menu actions (round 3b §6.4)', () => {
  const labels = () => screen.getAllByRole('menuitem').map((i) => i.textContent);
  const realLoad = usePageStore.getState().load;
  afterEach(() => usePageStore.setState({ load: realLoad }));

  it('"Add a page to this folder" creates X/X.md and opens it', async () => {
    const calls = backend({
      entry_create_page: () => 'Lore/Lore.md',
      vault_tree: () => [
        { path: 'Lore', kind: 'folder' },
        { path: 'Lore/Lore.md', kind: 'page' },
      ],
    });
    const load = vi.fn(async () => {});
    usePageStore.setState({ load });
    seed([{ path: 'Lore', kind: 'folder' }]);
    render(<ContextMenu menu={{ path: 'Lore', anchor: { x: 0, y: 0 } }} onClose={() => {}} />);
    expect(labels()).toContain('Add a page to this folder');
    expect(labels()).not.toContain('Use Lore.md as this folder’s page');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Add a page to this folder' }));
    await waitFor(() => expect(load).toHaveBeenCalledWith('Lore/Lore.md'));
    expect(calls).toContainEqual(['entry_create_page', { dir: 'Lore', name: 'Lore' }]);
    expect(useVaultStore.getState().renaming).toBeNull();
  });

  it('"Use Lore.md as this folder’s page" moves the namesake page inside', async () => {
    const calls = backend({
      entry_rename: () => ({
        moved: [],
        updatedFiles: [],
        updatedLinks: 0,
        failed: [],
        pair: null,
      }),
    });
    seed([
      { path: 'Lore', kind: 'folder' },
      { path: 'Lore.md', kind: 'page' },
    ]);
    render(<ContextMenu menu={{ path: 'Lore', anchor: { x: 0, y: 0 } }} onClose={() => {}} />);
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Use Lore.md as this folder’s page' }),
    );
    expect(calls).toContainEqual(['entry_rename', { from: 'Lore.md', to: 'Lore/Lore.md' }]);
  });

  it('a folder with a page offers neither, and its Favorites action stars the page', async () => {
    backend({ favorites_set: () => null });
    useFavoritesStore.setState({ paths: [] });
    seed([
      { path: 'Lore', kind: 'folder' },
      { path: 'Lore/Lore.md', kind: 'page' },
    ]);
    render(<ContextMenu menu={{ path: 'Lore', anchor: { x: 0, y: 0 } }} onClose={() => {}} />);
    expect(labels()).not.toContain('Add a page to this folder');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Add to Favorites' }));
    expect(useFavoritesStore.getState().paths).toEqual(['Lore/Lore.md']);
  });

  it('an archived folder offers neither', () => {
    seed([
      { path: '.archive', kind: 'folder' },
      { path: '.archive/Lore', kind: 'folder' },
    ]);
    render(
      <ContextMenu menu={{ path: '.archive/Lore', anchor: { x: 0, y: 0 } }} onClose={() => {}} />,
    );
    expect(labels()).not.toContain('Add a page to this folder');
  });
});

describe('double-click a page (round 3b §8.1)', () => {
  const realLoad = usePageStore.getState().load;
  const loads: string[] = [];
  const load = vi.fn(async (p: string) => {
    loads.push(p);
    usePageStore.setState({ path: p });
  });
  afterEach(() => {
    usePageStore.setState({ load: realLoad, path: null, editorFocus: false });
    useUiStore.setState({ screen: 'edit' });
    loads.length = 0;
  });
  const start = (screenNow: 'edit' | 'global', open: string | null, list = nodes) => {
    usePageStore.setState({ load, path: open, editorFocus: false });
    useUiStore.setState({ screen: screenNow });
    seed(list);
    render(<ExplorerTree />);
  };
  const row = (name: string) => screen.getByRole('treeitem', { name });

  it('from the Global View it opens the page for editing, without renaming', async () => {
    start('global', 'Welcome.md');
    await userEvent.dblClick(row('Welcome'));
    expect(useUiStore.getState().screen).toBe('edit');
    expect(usePageStore.getState().editorFocus).toBe(true);
    expect(useVaultStore.getState().renaming).toBeNull();
  });

  it('on the page already open for editing it renames it', async () => {
    start('edit', 'Welcome.md');
    await userEvent.dblClick(row('Welcome'));
    expect(useVaultStore.getState().renaming).toBe('Welcome.md');
  });

  it('on another page it opens that one; the first click switching pages starts no rename', async () => {
    start('edit', 'Art/rex.md');
    await userEvent.dblClick(row('Welcome'));
    expect(loads).toContain('Welcome.md');
    expect(useVaultStore.getState().renaming).toBeNull();
    expect(usePageStore.getState().editorFocus).toBe(true);
  });

  it('a folder page row renames the folder when its page is the one open', async () => {
    start('edit', 'Lore/Lore.md', [
      { path: 'Lore', kind: 'folder' },
      { path: 'Lore/Lore.md', kind: 'page' },
    ]);
    await userEvent.dblClick(within(row('Lore')).getByText('Lore'));
    expect(useVaultStore.getState().renaming).toBe('Lore');
  });
});
