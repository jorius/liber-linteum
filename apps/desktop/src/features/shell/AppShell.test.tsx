import { undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TreeNode } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { fakeDisk } from '../../test/fakeDisk';
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
    expect(side).not.toHaveTextContent('Notes In My Way');
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
    ).toEqual(['Settings…', 'Open another vault…', 'Close vault']);
    expect(within(menu).getByRole('menuitem', { name: 'Settings…' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
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
    expect(search).toHaveAttribute('aria-keyshortcuts', 'Meta+F Control+F');
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

  it('NFR-10 has no axe violations', async () => {
    seed('Art/rex.md');
    const { container } = render(<AppShell />);
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
