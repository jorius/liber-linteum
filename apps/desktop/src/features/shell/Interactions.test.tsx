import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from '@codemirror/view';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import type { TreeNode } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { childrenByParent } from '../../stores/tree';
import { openPage } from '../../stores/navigate';
import { useUiStore } from '../../stores/uiStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { dropEntry } from '../explorer/drop';
import { AppShell } from './AppShell';

const nodes: TreeNode[] = [
  { path: 'Art', kind: 'folder' },
  { path: 'Art/DMC', kind: 'folder' },
  { path: 'Art/DMC/Sparda.md', kind: 'page' },
  { path: 'Art/rex.md', kind: 'page' },
  { path: 'Games', kind: 'folder' },
  { path: 'Welcome.md', kind: 'page' },
];

function seed(selected: string | null = null, expanded: string[] = []) {
  act(() =>
    useVaultStore.setState({
      status: 'open',
      info: { name: 'Vault', root: '/v', report: {} as never },
      nodes,
      children: childrenByParent(nodes),
      expanded: new Set(expanded),
      selected,
    }),
  );
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

const outcome = { moved: [], updatedFiles: [], updatedLinks: 0, failed: [] };
const axeRun = (el: Element) =>
  axe.run(el, { rules: { 'color-contrast': { enabled: false } } }).then((r) => r.violations);

afterEach(async () => {
  await resetVaultStore();
  usePageStore.getState().clear();
  useUiStore.getState().closeDialog();
  useToastStore.getState().clear();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  clearMocks();
});

describe('context menu', () => {
  it('opens with Shift+F10, navigates with arrows and closes with Escape', async () => {
    backend({});
    seed();
    render(<AppShell />);
    screen.getByRole('treeitem', { name: 'Welcome' }).focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    const menu = screen.getByRole('menu', { name: 'Actions for Welcome' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'New page',
      'New folder',
      'Rename',
      'Move to…',
      'Icon…',
      'Sort by',
      'Archive',
      'Delete',
    ]);
    expect(items[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(items[2]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(items[1]).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(await axeRun(document.body)).toEqual([]);
  });

  it('Sort by: → opens the orders with the current one checked; a choice saves it and reloads the tree (M5b round 2)', async () => {
    const calls = backend({
      folder_sort_get: () => 'modified-desc',
      folder_sort_set: () => null,
      vault_tree: () => nodes,
    });
    seed();
    render(<AppShell />);
    screen.getByRole('treeitem', { name: 'Art' }).focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    const sortBy = screen.getByRole('menuitem', { name: 'Sort by' });
    expect(sortBy).toHaveAttribute('aria-haspopup', 'menu');
    sortBy.focus();
    await userEvent.keyboard('{ArrowRight}');
    const orders = await screen.findByRole('menu', { name: 'Sort Art by' });
    const radios = within(orders).getAllByRole('menuitemradio');
    expect(radios.map((r) => r.textContent)).toEqual([
      'Name, A → Z',
      'Name, Z → A',
      'Modified, newest first',
      'Modified, oldest first',
      'Created, newest first',
    ]);
    await waitFor(() => expect(radios[2]).toHaveAttribute('aria-checked', 'true'));
    expect(radios[0]).toHaveAttribute('aria-checked', 'false');
    // ← goes back to the actions.
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('menuitem', { name: 'Sort by' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Name, Z → A' }));
    await waitFor(() =>
      expect(calls.filter(([c]) => c === 'folder_sort_set')).toEqual([
        ['folder_sort_set', { path: 'Art', sort: 'name-desc' }],
      ]),
    );
    await waitFor(() => expect(calls.filter(([c]) => c === 'vault_tree').length).toBe(1));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it("a page's Sort by orders its folder; the files header sorts the vault root (M5b round 2)", async () => {
    const calls = backend({
      folder_sort_get: () => 'name-asc',
      folder_sort_set: () => null,
      vault_tree: () => nodes,
    });
    seed();
    render(<AppShell />);
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'Welcome' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sort by' }));
    await userEvent.click(
      await screen.findByRole('menuitemradio', { name: 'Modified, newest first' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sort the vault' }));
    expect(await screen.findByRole('menu', { name: 'Sort Vault by' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Created, newest first' }));
    await waitFor(() =>
      expect(calls.filter(([c]) => c === 'folder_sort_set').map(([, a]) => a)).toEqual([
        { path: '', sort: 'modified-desc' },
        { path: '', sort: 'created-desc' },
      ]),
    );
  });

  it('Archive moves the item into the Archive and offers Undo (M5b §5.3)', async () => {
    const calls = backend({
      entry_archive: (a) => ({ ...outcome, moved: [[a.path, `.archive/${String(a.path)}`]] }),
      vault_tree: () => nodes.filter((n) => n.path !== 'Welcome.md'),
      bin_list: () => ({ trash: [], archive: [] }),
    });
    seed();
    render(<AppShell />);
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'Welcome' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() =>
      expect(calls.filter(([c]) => c === 'entry_archive')).toEqual([
        ['entry_archive', { path: 'Welcome.md' }],
      ]),
    );
    await waitFor(() =>
      expect(screen.queryByRole('treeitem', { name: 'Welcome' })).not.toBeInTheDocument(),
    );
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
      message: 'Archived',
      action: { label: 'Undo' },
    });
  });

  it('right-click opens the menu; Rename starts inline rename', async () => {
    backend({});
    seed();
    render(<AppShell />);
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'Welcome' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(useVaultStore.getState().renaming).toBe('Welcome.md');
    expect(screen.getByRole('textbox', { name: 'Rename' })).toBeInTheDocument();
  });
});

describe('delete (EXP-03)', () => {
  it('asks first, with the backlink count, then moves to Trash', async () => {
    let current = nodes;
    const calls = backend({
      backlink_count: () => 3,
      entry_trash: (a) => {
        current = current.filter((n) => n.path !== a.path);
      },
      vault_tree: () => current,
    });
    seed();
    render(<AppShell />);
    screen.getByRole('treeitem', { name: 'Welcome' }).focus();
    await userEvent.keyboard('{Delete}');
    const dialog = await screen.findByRole('dialog', { name: 'Move “Welcome” to Trash?' });
    expect(
      await within(dialog).findByText('3 links point to it and will break.'),
    ).toBeInTheDocument();
    expect(await axeRun(dialog)).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(calls.map(([c]) => c)).toContain('entry_trash'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a folder shows how many items it contains; Cancel keeps everything', async () => {
    const calls = backend({ backlink_count: () => 0 });
    seed();
    render(<AppShell />);
    act(() => useUiStore.getState().openDialog({ type: 'delete', path: 'Art' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('It contains 3 items.')).toBeInTheDocument();
    expect(await within(dialog).findByText('Nothing links to it.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.map(([c]) => c)).not.toContain('entry_trash');
  });

  it('"Don\'t ask again" turns confirmation off; then Delete trashes immediately', async () => {
    let current = nodes;
    const calls = backend({
      backlink_count: () => 0,
      settings_set: (a) => ({ ...DEFAULT_SETTINGS, ...(a.patch as object) }),
      entry_trash: (a) => {
        current = current.filter((n) => n.path !== a.path);
      },
      vault_tree: () => current,
    });
    seed();
    render(<AppShell />);
    act(() => useUiStore.getState().openDialog({ type: 'delete', path: 'Welcome.md' }));
    await userEvent.click(screen.getByRole('checkbox', { name: "Don't ask again" }));
    await userEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(useSettingsStore.getState().settings.confirmDelete).toBe(false));
    expect(calls.find(([c]) => c === 'settings_set')?.[1]).toEqual({
      patch: { confirmDelete: false },
    });
    screen.getByRole('treeitem', { name: 'Games' }).focus();
    await userEvent.keyboard('{Delete}');
    await waitFor(() =>
      expect(calls.filter(([c]) => c === 'entry_trash').map(([, a]) => a.path)).toEqual([
        'Welcome.md',
        'Games',
      ]),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('move (EXP-02)', () => {
  it('"Move to…" lists valid folders and moves the item', async () => {
    const calls = backend({ entry_rename: () => outcome, vault_tree: () => nodes });
    seed();
    render(<AppShell />);
    act(() => useUiStore.getState().openDialog({ type: 'move', path: 'Art/DMC' }));
    const dialog = screen.getByRole('dialog', { name: 'Move “DMC”' });
    const select = within(dialog).getByRole('listbox', { name: 'Destination folder' });
    const options = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Vault root', 'Games']); // not itself, its folder or descendants
    expect(await axeRun(dialog)).toEqual([]);
    await userEvent.selectOptions(select, 'Games');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() =>
      expect(calls.find(([c]) => c === 'entry_rename')?.[1]).toEqual({
        from: 'Art/DMC',
        to: 'Games/DMC',
      }),
    );
  });

  it('a drop onto a folder moves the item; forbidden drops do nothing', async () => {
    const calls = backend({ entry_rename: () => outcome, vault_tree: () => nodes });
    seed();
    expect(await dropEntry('Art', 'Art/DMC')).toBe(false);
    expect(await dropEntry('Welcome.md', 'Games')).toBe(true);
    expect(calls.filter(([c]) => c === 'entry_rename').map(([, a]) => a)).toEqual([
      { from: 'Welcome.md', to: 'Games/Welcome.md' },
    ]);
  });
});

describe('settings dialog', () => {
  it('changes are saved immediately; Escape closes; focus stays inside', async () => {
    const calls = backend({
      settings_set: (a) => ({ ...useSettingsStore.getState().settings, ...(a.patch as object) }),
    });
    seed();
    render(<AppShell />);
    // M5b §11.1: Settings… in the vault menu.
    await userEvent.click(
      screen.getByRole('button', { name: useVaultStore.getState().info!.name }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Settings…' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(await axeRun(dialog)).toEqual([]);
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Dark' }));
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'Language' }), 'es');
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: /Actualizar enlaces|Update links/ }),
    );
    await waitFor(() =>
      expect(calls.filter(([c]) => c === 'settings_set').map(([, a]) => a.patch)).toEqual([
        { theme: 'dark' },
        { language: 'es' },
        { rewriteLinks: false },
      ]),
    );
    // Tab from the last control wraps to the first (focus trap).
    const focusables = within(dialog).getAllByRole('button');
    focusables.at(-1)!.focus();
    await userEvent.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('global shortcuts (spec §3.5)', () => {
  it('⌘, opens settings; ⌘N creates a page; ⌘⇧E focuses the explorer', async () => {
    let current = nodes;
    const calls = backend({
      vault_tree: () => current,
      entry_create_page: (a) => {
        const path = a.dir ? `${a.dir}/${a.name}.md` : `${a.name}.md`;
        current = [...current, { path, kind: 'page' }];
        return path;
      },
    });
    seed('Games');
    render(<AppShell />);
    await userEvent.keyboard('{Meta>},{/Meta}');
    expect(useUiStore.getState().dialog).toEqual({ type: 'settings' });
    act(() => useUiStore.getState().closeDialog());
    await userEvent.keyboard('{Control>}n{/Control}');
    await waitFor(() =>
      expect(calls.find(([c]) => c === 'entry_create_page')?.[1]).toEqual({
        dir: 'Games',
        name: 'Untitled',
      }),
    );
    act(() => useVaultStore.getState().startRename(null));
    document.body.focus();
    await userEvent.keyboard('{Meta>}{Shift>}e{/Shift}{/Meta}');
    expect(document.activeElement).toHaveAttribute('role', 'treeitem');
  });
});

describe('link trail keys (M2b §3)', () => {
  it('⌘[ goes back and ⌘] forward along followed links', async () => {
    backend({
      page_get: (a) => ({
        path: a.path,
        title: String(a.path).replace(/\.md$/, ''),
        subtitle: null,
        cover: null,
        tags: [],
        links: 0,
        backlinks: 0,
        text: '',
        truncated: false,
        binary: false,
      }),
      page_read: () => ({ text: '', hash: 'h' }),
    });
    seed();
    render(<AppShell />);
    await act(() => openPage('Welcome.md'));
    await act(() => openPage('Art/rex.md', null, 'link'));
    document.body.focus();
    await userEvent.keyboard('{Meta>}[[{/Meta}');
    await waitFor(() => expect(usePageStore.getState().path).toBe('Welcome.md'));
    await userEvent.keyboard('{Control>}]{/Control}');
    await waitFor(() => expect(usePageStore.getState().path).toBe('Art/rex.md'));
  });

  /** Pages with an indented list: CodeMirror's default Mod-[ / Mod-] would
   *  outdent / indent them, so a changed text means the editor took the key. */
  function trailPages() {
    const text = '- a\n  - b\n';
    backend({
      page_get: (a) => ({
        path: a.path,
        title: String(a.path).replace(/\.md$/, ''),
        subtitle: null,
        cover: null,
        tags: [],
        links: 0,
        backlinks: 0,
        text,
        truncated: false,
        binary: false,
      }),
      page_read: () => ({ text, hash: 'h' }),
      page_write: () => ({ hash: 'h2' }),
    });
    return text;
  }
  /** The editor on screen once `path` is shown, with the cursor at `pos`. */
  async function editorAt(path: string, pos: number) {
    await waitFor(() => expect(usePageStore.getState().path).toBe(path));
    const view = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.cm-editor');
      const v = el && EditorView.findFromDOM(el);
      expect(v?.state.doc.toString()).toBe('- a\n  - b\n');
      return v!;
    });
    act(() => view.dispatch({ selection: { anchor: pos } }));
    view.contentDOM.focus();
    return view;
  }

  it('review focus: ⌘[ / ⌘] typed in an indented list go back / forward instead of (out)denting', async () => {
    const text = trailPages();
    seed();
    render(<AppShell />);
    await act(() => openPage('Welcome.md'));
    await act(() => openPage('Art/rex.md', null, 'link'));
    // Cursor in the nested item: Mod-[ (indentLess) would outdent it.
    // jsdom isn't a Mac, so CodeMirror's Mod is Ctrl here: press Ctrl so a
    // still-bound Mod-[ / Mod-] would fire (our handler takes ⌘ or Ctrl).
    let view = await editorAt('Art/rex.md', text.indexOf('b'));
    await userEvent.keyboard('{Control>}[[{/Control}');
    expect(view.state.doc.toString()).toBe(text);
    // Cursor in the top-level item: Mod-] (indentMore) would indent it.
    view = await editorAt('Welcome.md', 1);
    await userEvent.keyboard('{Control>}]{/Control}');
    expect(view.state.doc.toString()).toBe(text);
    await editorAt('Art/rex.md', 0);
  });

  it('final review m5: ⌘[ / ⌘] work where brackets need Option (Spanish, German, French Macs)', async () => {
    trailPages();
    seed();
    render(<AppShell />);
    await act(() => openPage('Welcome.md'));
    await act(() => openPage('Art/rex.md', null, 'link'));
    const at = () => usePageStore.getState().path;
    const press = (init: KeyboardEventInit) =>
      act(() => void fireEvent.keyDown(document.body, { metaKey: true, ...init }));
    // Spanish: ⌘⌥ + the key right of P types "[".
    press({ altKey: true, key: '[', code: 'BracketLeft' });
    await waitFor(() => expect(at()).toBe('Welcome.md'));
    press({ altKey: true, key: ']', code: 'BracketRight' });
    await waitFor(() => expect(at()).toBe('Art/rex.md'));
    // German: ⌘ü / ⌘+ (the keys where US has [ and ]).
    press({ key: 'ü', code: 'BracketLeft' });
    await waitFor(() => expect(at()).toBe('Welcome.md'));
    press({ key: '+', code: 'BracketRight' });
    await waitFor(() => expect(at()).toBe('Art/rex.md'));
    // French: a dead key (^) at the same place.
    press({ key: 'Dead', code: 'BracketLeft' });
    await waitFor(() => expect(at()).toBe('Welcome.md'));
    press({ key: 'Dead', code: 'BracketRight' });
    await waitFor(() => expect(at()).toBe('Art/rex.md'));
    // Not stolen: AltGr (Ctrl+Alt) typing "[" on Windows/Linux, and Dvorak's
    // ⌘/ which sits on that physical key.
    press({ metaKey: false, ctrlKey: true, altKey: true, key: '[', code: 'Digit8' });
    press({ key: '/', code: 'BracketLeft' });
    await act(async () => {});
    expect(at()).toBe('Art/rex.md');
  });
});

describe('keyboard focus is never lost (final review I1, NFR-10)', () => {
  const tabStops = () => screen.getAllByRole('treeitem').filter((el) => el.tabIndex === 0);

  it('after trashing the focused row, a visible row keeps the Tab stop and focus', async () => {
    let current = nodes;
    backend({
      entry_trash: (a) => {
        current = current.filter((n) => n.path !== a.path);
      },
      vault_tree: () => current,
    });
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, confirmDelete: false } });
    seed();
    render(<AppShell />);
    screen.getByRole('treeitem', { name: 'Art' }).focus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('treeitem', { name: 'Welcome' })).toHaveFocus();
    await userEvent.keyboard('{Delete}');
    await waitFor(() =>
      expect(screen.queryByRole('treeitem', { name: 'Welcome' })).not.toBeInTheDocument(),
    );
    expect(tabStops()).toHaveLength(1);
    expect(document.activeElement?.getAttribute('role')).toBe('treeitem');
  });

  it('moving into a collapsed folder reveals the moved item and keeps it the Tab stop', async () => {
    const moved = nodes
      .filter((n) => n.path !== 'Welcome.md')
      .concat({ path: 'Art/DMC/Welcome.md', kind: 'page' });
    backend({
      entry_rename: () => ({ ...outcome, moved: [['Welcome.md', 'Art/DMC/Welcome.md']] }),
      vault_tree: () => moved,
    });
    seed('Welcome.md');
    render(<AppShell />);
    await act(() => useVaultStore.getState().rename('Welcome.md', 'Art/DMC/Welcome.md'));
    const row = await screen.findByRole('treeitem', { name: 'Welcome' });
    expect(row).toHaveAttribute('aria-level', '3');
    expect(tabStops()).toEqual([row]);
  });

  it('a new page inside a collapsed folder is revealed for inline rename', async () => {
    let current = nodes;
    backend({
      entry_create_page: (a) => {
        current = current.concat({ path: `${a.dir}/${a.name}.md`, kind: 'page' });
        return `${a.dir}/${a.name}.md`;
      },
      vault_tree: () => current,
    });
    seed('Art/DMC/Sparda.md');
    render(<AppShell />);
    await act(() => useVaultStore.getState().createPage('Art/DMC'));
    expect(await screen.findByRole('textbox', { name: 'Rename' })).toBeInTheDocument();
  });
});

describe('stale menus and dialogs (final review, upgraded M3)', () => {
  it('a dialog whose item vanished closes itself, so shortcuts keep working', async () => {
    backend({ backlink_count: () => 0 });
    seed();
    render(<AppShell />);
    act(() => useUiStore.getState().openDialog({ type: 'move', path: 'Welcome.md' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const rest = nodes.filter((n) => n.path !== 'Welcome.md');
    act(() => useVaultStore.setState({ nodes: rest, children: childrenByParent(rest) }));
    await waitFor(() => expect(useUiStore.getState().dialog).toBeNull());
  });

  it('a context menu whose item vanished closes itself', async () => {
    backend({});
    seed();
    render(<AppShell />);
    screen.getByRole('treeitem', { name: 'Welcome' }).focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    const rest = nodes.filter((n) => n.path !== 'Welcome.md');
    act(() => useVaultStore.setState({ nodes: rest, children: childrenByParent(rest) }));
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await userEvent.keyboard('{Meta>},{/Meta}');
    expect(useUiStore.getState().dialog).toEqual({ type: 'settings' });
  });
});
