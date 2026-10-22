import { undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TreeNode } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { fakeDisk } from '../../test/fakeDisk';
import { resetEditorStore } from '../../stores/editorStore';
import { installReactFlowStubs } from '../../test/reactFlow';
import { openPage } from '../../stores/navigate';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { childrenByParent } from '../../stores/tree';
import { useUiStore } from '../../stores/uiStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { AppShell } from './AppShell';

const nodes: TreeNode[] = [
  { path: 'Art', kind: 'folder' },
  { path: 'Art/rex.md', kind: 'page' },
  { path: 'Welcome.md', kind: 'page' },
];

function seed(selected: string | null = null) {
  act(() =>
    useVaultStore.setState({
      status: 'open',
      info: { name: 'Digital Brain', root: '/v/Digital Brain', report: {} as never },
      nodes,
      children: childrenByParent(nodes),
      expanded: new Set(),
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

beforeAll(installReactFlowStubs);

afterEach(async () => {
  // A page a test opened would otherwise autosave into the next test's mock,
  // which answers page_write with nothing (the 1-in-8 failure, M5b round 2).
  resetEditorStore();
  await resetVaultStore();
  usePageStore.getState().clear();
  useUiStore.getState().closeDialog();
  useUiStore.setState({ screen: 'edit', actionsOpen: false });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  clearMocks();
});

describe('AppShell', () => {
  it('shows the sidebar explorer, the vault name and the empty page state', () => {
    seed();
    render(<AppShell />);
    expect(
      screen.getByRole('complementary', { name: 'Files · Digital Brain' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tree', { name: 'Files' })).toBeInTheDocument();
    // The vault's name is in the sidebar (M4b §1).
    expect(screen.getByRole('complementary', { name: 'Files · Digital Brain' })).toHaveTextContent(
      'Digital Brain',
    );
    expect(screen.getByText('Pick a page in the explorer')).toBeInTheDocument();
  });

  it('M5b §2.3: no top bar; the page header holds the title and subtitle, and the window is named after the page', async () => {
    seed();
    const calls: [string, Record<string, unknown>][] = [];
    fakeDisk(
      { 'Art/rex.md': '---\nsubtitle: Hero redesign\n---\n# Generator Rex\n\nbody\n' },
      {
        vault_tree: () => nodes,
        gv_children: () => ({ cards: [], centre: null }),
        gv_edges: () => [],
        layout_get: () => ({}),
        window_title_set: (a) => {
          calls.push(['window_title_set', a]);
          return null;
        },
      },
    );
    render(<AppShell />);
    const side = screen.getByRole('complementary', { name: 'Files · Digital Brain' });
    expect(side).toHaveTextContent('Digital Brain');
    expect(side).not.toHaveTextContent('Liber Linteum');
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    await act(() => openPage('Art/rex.md'));
    const page = screen.getByRole('region', { name: 'Page' });
    const title = await within(page).findByRole('textbox', { name: 'Page title' });
    expect(title).toHaveValue('rex');
    expect(within(page).getByRole('heading', { level: 1 })).toContainElement(title);
    expect(within(page).getByRole('textbox', { name: 'Subtitle' })).toHaveValue('Hero redesign');
    await waitFor(() =>
      expect(calls.at(-1)).toEqual(['window_title_set', { title: 'rex — Digital Brain' }]),
    );
    act(() => useUiStore.getState().setScreen('global'));
    await waitFor(() =>
      expect(calls.at(-1)).toEqual(['window_title_set', { title: 'Global view — Digital Brain' }]),
    );
  });

  it('final review M10: the window title names the Trash, and goes back to the app name on close', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    seed();
    backend({
      bin_list: () => ({ trash: [], archive: [] }),
      window_title_set: (a) => {
        calls.push(['window_title_set', a]);
        return null;
      },
    });
    const { unmount } = render(<AppShell />);
    act(() => useUiStore.getState().setScreen('trash'));
    await waitFor(() =>
      expect(calls.at(-1)).toEqual(['window_title_set', { title: 'Trash — Digital Brain' }]),
    );
    unmount();
    expect(calls.at(-1)).toEqual(['window_title_set', { title: 'Liber Linteum' }]);
  });

  it('M3a §2: Edit and Global view switch the screen; the editor stays mounted (undo survives)', async () => {
    seed();
    fakeDisk(
      { 'Welcome.md': 'hello\n' },
      {
        vault_tree: () => nodes,
        gv_children: () => ({ cards: [], centre: null }),
        gv_edges: () => [],
        layout_get: () => ({}),
      },
    );
    render(<AppShell />);
    await act(() => openPage('Welcome.md'));
    const view = () => EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
    const before = view();
    act(() => before.dispatch({ changes: { from: 5, insert: ' world' }, userEvent: 'input.type' }));

    // M5b §2.2: through the floating button.
    const actions = screen.getByRole('button', { name: 'Actions' });
    await userEvent.click(actions);
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Global view' }));
    expect(screen.queryByRole('button', { name: 'Global view' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Global View' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Page' })).not.toBeInTheDocument();

    await userEvent.click(actions);
    expect(screen.getByRole('button', { name: 'Global view' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.queryByRole('region', { name: 'Global View' })).not.toBeInTheDocument();
    expect(view()).toBe(before);
    expect(view().state.doc.toString()).toBe('hello world\n');
    act(() => {
      undo(view());
    });
    expect(view().state.doc.toString()).toBe('hello\n');
  });

  it('M3a §2: ⌘1 / ⌘2 (Ctrl elsewhere) switch between Edit and the Global View', async () => {
    seed();
    fakeDisk({}, { gv_children: () => ({ cards: [], centre: null }), gv_edges: () => [] });
    render(<AppShell />);
    const key = (k: string) =>
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true }),
        );
      });
    await key('2');
    expect(useUiStore.getState().screen).toBe('global');
    await key('1');
    expect(useUiStore.getState().screen).toBe('edit');
  });

  it("new page goes into the selected folder (or the selected file's folder)", async () => {
    let current = nodes;
    const calls = backend({
      vault_tree: () => current,
      entry_create_page: (a) => {
        const path = `${a.dir}/${a.name}.md`;
        current = [...current, { path, kind: 'page' }];
        return path;
      },
      entry_create_folder: (a) => {
        const path = `${a.parent}/${a.name}`;
        current = [...current, { path, kind: 'folder' }];
        return path;
      },
    });
    seed('Art/rex.md');
    render(<AppShell />);
    await userEvent.click(screen.getByRole('button', { name: 'New page' }));
    await waitFor(() =>
      expect(calls.find(([c]) => c === 'entry_create_page')?.[1]).toEqual({
        dir: 'Art',
        name: 'Untitled',
      }),
    );
    act(() => useVaultStore.setState({ selected: 'Art', renaming: null }));
    await userEvent.click(screen.getByRole('button', { name: 'New folder' }));
    await waitFor(() =>
      expect(calls.find(([c]) => c === 'entry_create_folder')?.[1]).toEqual({
        parent: 'Art',
        name: 'Untitled',
      }),
    );
  });

  it('M5b §11.1: the vault menu opens Settings and closes the vault', async () => {
    const calls = backend({ vault_close: () => undefined });
    seed();
    render(<AppShell />);
    const vault = screen.getByRole('button', { name: 'Digital Brain' });
    expect(vault).toHaveAttribute('aria-haspopup', 'menu');
    await userEvent.click(vault);
    const menu = screen.getByRole('menu', { name: 'Digital Brain' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual([
      'New vault…',
      'Open another vault…',
      'Create new scratchpad for “Digital Brain”',
      'Encrypt “Digital Brain”…',
      'Settings…',
      'Close vault',
    ]);
    expect(within(menu).getByRole('menuitem', { name: 'New vault…' })).toHaveFocus();
    await userEvent.keyboard('{End}{ArrowUp}{Enter}');
    expect(useUiStore.getState().dialog).toEqual({ type: 'settings' });
    act(() => useUiStore.getState().closeDialog());
    await userEvent.click(vault);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(vault).toHaveFocus();
    await userEvent.click(vault);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Close vault' }));
    await waitFor(() => expect(useVaultStore.getState().status).toBe('closed'));
    expect(calls.map(([c]) => c)).toContain('vault_close');
  });

  it('UX round §4.1, §10.1: the vault menu offers Encrypt for a plain vault, Decrypt for an encrypted one', async () => {
    backend({});
    seed();
    act(() => useVaultStore.setState((s) => ({ info: s.info && { ...s.info, encrypted: true } })));
    render(<AppShell />);
    await userEvent.click(screen.getByRole('button', { name: 'Digital Brain' }));
    const menu = screen.getByRole('menu', { name: 'Digital Brain' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual([
      'New vault…',
      'Open another vault…',
      'Create new scratchpad for “Digital Brain”',
      'Decrypt “Digital Brain”…',
      'Lock vault',
      'Settings…',
      'Close vault',
    ]);
    const lock = vi.spyOn(useVaultStore.getState(), 'lock').mockResolvedValue(true);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Lock vault' }));
    expect(lock).toHaveBeenCalledWith('menu');
    lock.mockRestore();
    await userEvent.click(screen.getByRole('button', { name: 'Digital Brain' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Decrypt “Digital Brain”…' }));
    expect(useUiStore.getState().dialog).toEqual({
      type: 'decryptInPlace',
      root: useVaultStore.getState().info!.root,
    });
  });

  it('Windows and Linux have no app menu: the vault menu makes a scratchpad note', async () => {
    seed();
    // The whole quick note runs (create, tree, open) and the test waits for
    // its end: an unanswered vault_tree crashed it after the test (CI).
    const note = 'Scratchpad/Quick note.md';
    const disk = fakeDisk(
      { [note]: '' },
      {
        quick_notes_state: () => ({ folder: 'Scratchpad', autoNamed: [] }),
        quick_note_create: () => note,
        vault_tree: () => [
          ...nodes,
          { path: 'Scratchpad', kind: 'folder' },
          { path: note, kind: 'page' },
        ],
      },
    );
    render(<AppShell />);
    await userEvent.click(screen.getByRole('button', { name: 'Digital Brain' }));
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Create new scratchpad for “Digital Brain”' }),
    );
    await waitFor(() => expect(usePageStore.getState().path).toBe(note));
    expect(disk.calls.some(([c]) => c === 'quick_note_create')).toBe(true);
  });

  it('UX round §4.1: Encrypt “<name>”… starts encrypting the open plain vault', async () => {
    backend({});
    seed();
    render(<AppShell />);
    await userEvent.click(screen.getByRole('button', { name: 'Digital Brain' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Encrypt “Digital Brain”…' }));
    const root = useVaultStore.getState().info!.root;
    await waitFor(() =>
      expect(useUiStore.getState().dialog).toEqual({ type: 'encryptInPlace', root }),
    );
  });

  it('M5b §2.5: the sidebar collapses (button, ⌘\\) and the setting remembers it', async () => {
    const calls = backend({
      settings_set: (a) => ({ ...useSettingsStore.getState().settings, ...(a.patch as object) }),
    });
    seed();
    render(<AppShell />);
    await userEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    await waitFor(() => expect(screen.queryByRole('complementary')).not.toBeInTheDocument());
    expect(calls.find(([c]) => c === 'settings_set')?.[1]).toEqual({
      patch: { sidebarCollapsed: true },
    });
    const show = screen.getByRole('button', { name: 'Show sidebar' });
    expect(show).toHaveAttribute('aria-keyshortcuts', 'Meta+\\ Control+\\');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', metaKey: true }));
    });
    expect(
      await screen.findByRole('complementary', { name: 'Files · Digital Brain' }),
    ).toBeInTheDocument();
  });

  it('round 3 §2.1: the sidebar resizes by drag and keys, clamps to 200–560, and remembers its width', async () => {
    const calls = backend({
      settings_set: (a) => ({ ...useSettingsStore.getState().settings, ...(a.patch as object) }),
    });
    const patches = () => calls.filter(([c]) => c === 'settings_set').map(([, a]) => a.patch);
    seed();
    render(<AppShell />);
    const side = screen.getByRole('complementary');
    const edge = screen.getByRole('separator', { name: 'Resize the sidebar' });
    const width = () => side.style.getPropertyValue('--sidebar-width');
    expect(edge).toHaveAttribute('aria-valuenow', '270');
    expect(edge).toHaveAttribute('aria-valuemin', '200');
    expect(edge).toHaveAttribute('aria-valuemax', '560');
    expect(width()).toBe('270px');
    // Keys: → wider, Shift ×4, saved each time.
    edge.focus();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(patches().at(-1)).toEqual({ sidebarWidth: 286 }));
    expect(width()).toBe('286px');
    await userEvent.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    await waitFor(() => expect(patches().at(-1)).toEqual({ sidebarWidth: 222 }));
    // Dragging follows the pointer, clamps, and saves once on release.
    const at = (type: string, x: number) =>
      act(() => {
        edge.dispatchEvent(
          new PointerEvent(type, { bubbles: true, clientX: x, clientY: 300, pointerId: 1 }),
        );
      });
    const before = patches().length;
    await at('pointerdown', 222);
    await at('pointermove', 400);
    expect(edge).toHaveAttribute('aria-valuenow', '400');
    await at('pointermove', 2000);
    expect(width()).toBe('560px');
    expect(patches().length).toBe(before);
    await at('pointerup', 2000);
    await waitFor(() => expect(patches().at(-1)).toEqual({ sidebarWidth: 560 }));
    // A double-click puts the default back.
    fireEvent.doubleClick(edge);
    await waitFor(() => expect(patches().at(-1)).toEqual({ sidebarWidth: 270 }));
    expect(width()).toBe('270px');
  });

  it('round 3b final review: a release that arrives before the last move renders keeps the dragged width', async () => {
    backend({
      settings_set: (a) => ({ ...useSettingsStore.getState().settings, ...(a.patch as object) }),
    });
    seed();
    render(<AppShell />);
    const edge = screen.getByRole('separator', { name: 'Resize the sidebar' });
    const fire = (type: string, x: number) =>
      edge.dispatchEvent(
        new PointerEvent(type, { bubbles: true, clientX: x, clientY: 300, pointerId: 1 }),
      );
    act(() => fire('pointerdown', 270));
    // A loaded machine: the move and the release land before React renders.
    act(() => {
      fire('pointermove', 420);
      fire('pointerup', 420);
    });
    await waitFor(() => expect(useSettingsStore.getState().settings.sidebarWidth).toBe(420));
    expect(edge).toHaveAttribute('aria-valuenow', '420');
  });

  it('round 3 review I1: held arrow keys never lose a step or go back while saves are in flight', async () => {
    const pending: (() => void)[] = [];
    const saved: number[] = [];
    backend({
      settings_set: (a) =>
        new Promise((resolve) => {
          const patch = a.patch as { sidebarWidth: number };
          pending.push(() => {
            saved.push(patch.sidebarWidth);
            resolve({ ...useSettingsStore.getState().settings, ...patch });
          });
        }),
    });
    seed();
    render(<AppShell />);
    const edge = screen.getByRole('separator', { name: 'Resize the sidebar' });
    const seen: number[] = [];
    const watch = () => seen.push(Number(edge.getAttribute('aria-valuenow')));
    edge.focus();
    for (let i = 0; i < 3; i++) {
      await userEvent.keyboard('{ArrowRight}');
      watch();
    }
    // Answer every save, oldest first, as they reach the backend.
    for (let i = 0; i < 10 && saved.length < 3; i++) {
      await act(async () => {
        pending.shift()?.();
        await new Promise((r) => setTimeout(r, 0));
      });
      watch();
    }
    await waitFor(() => expect(edge).toHaveAttribute('aria-valuenow', '318'));
    watch();
    expect(seen).toEqual([...seen].sort((x, y) => x - y));
    expect(saved.at(-1)).toBe(318);
    expect(useSettingsStore.getState().settings.sidebarWidth).toBe(318);
  });

  it('final review I5: collapsing from inside the sidebar keeps the keyboard; reopening returns it', async () => {
    backend({
      settings_set: (a) => ({ ...useSettingsStore.getState().settings, ...(a.patch as object) }),
    });
    seed();
    render(<AppShell />);
    await userEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show sidebar' })).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Hide sidebar' })).toHaveFocus());
  });

  it('M5b §2.2: the floating button opens with the keyboard, ⌘J toggles it, Escape gives focus back', async () => {
    seed();
    render(<AppShell />);
    const actions = screen.getByRole('button', { name: 'Actions' });
    expect(actions).toHaveAttribute('aria-expanded', 'false');
    expect(actions.closest('[data-place]')).toHaveAttribute('data-place', 'bottomRight');
    actions.focus();
    await userEvent.keyboard('{Enter}');
    expect(actions).toHaveAttribute('aria-expanded', 'true');
    const search = screen.getByRole('button', { name: /^Search/ });
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute('aria-keyshortcuts', 'Meta+Shift+F Control+Shift+F');
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: /^Global view/ })).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(screen.getByRole('button', { name: /^Edit/ })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(actions).toHaveAttribute('aria-expanded', 'false');
    expect(actions).toHaveFocus();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true }));
    });
    expect(actions).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(screen.getByRole('button', { name: /^Search/ }));
    expect(useUiStore.getState().dialog).toEqual({ type: 'search' });
    expect(actions).toHaveAttribute('aria-expanded', 'false');
    act(() => useUiStore.getState().closeDialog());
    act(() =>
      useSettingsStore.setState({
        settings: { ...useSettingsStore.getState().settings, actionButton: 'topRight' },
      }),
    );
    expect(actions.closest('[data-place]')).toHaveAttribute('data-place', 'topRight');
  });

  it('final review M5: ⌘J and Tab close the group without losing the keyboard; an action keeps it', async () => {
    seed();
    render(<AppShell />);
    const actions = screen.getByRole('button', { name: 'Actions' });
    actions.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: /^Search/ })).toHaveFocus();
    act(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'j', metaKey: true, bubbles: true }),
      );
    });
    expect(actions).toHaveAttribute('aria-expanded', 'false');
    expect(actions).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    await userEvent.tab(); // Global view
    await userEvent.tab(); // Edit
    await userEvent.tab(); // the button
    await userEvent.tab(); // out of the group
    expect(actions).toHaveAttribute('aria-expanded', 'false');

    act(() => useUiStore.getState().setScreen('global'));
    await userEvent.click(actions);
    await userEvent.click(screen.getByRole('button', { name: /^Edit/ }));
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });

  it('NFR-10 has no axe violations', async () => {
    seed('Art/rex.md');
    const { container } = render(<AppShell />);
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
