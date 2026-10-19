import { undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TreeNode } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { fakeDisk } from '../../test/fakeDisk';
import { installReactFlowStubs } from '../../test/reactFlow';
import { openPage } from '../../stores/navigate';
import { usePageStore } from '../../stores/pageStore';
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
  useUiStore.setState({ screen: 'edit' });
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
    expect(screen.getByRole('banner')).toHaveTextContent('Digital Brain');
    expect(screen.getByText('Pick a page in the explorer')).toBeInTheDocument();
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

    const edit = screen.getByRole('button', { name: 'Edit' });
    const global = screen.getByRole('button', { name: 'Global view' });
    expect(edit).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(global);
    expect(global).toHaveAttribute('aria-pressed', 'true');
    expect(edit).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('region', { name: 'Global View' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Page' })).not.toBeInTheDocument();

    await userEvent.click(edit);
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

  it('settings opens the settings dialog; close vault returns to welcome', async () => {
    const calls = backend({ vault_close: () => undefined });
    seed();
    render(<AppShell />);
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(useUiStore.getState().dialog).toEqual({ type: 'settings' });
    await userEvent.click(screen.getByRole('button', { name: 'Close vault' }));
    await waitFor(() => expect(useVaultStore.getState().status).toBe('closed'));
    expect(calls.map(([c]) => c)).toContain('vault_close');
  });

  it('NFR-10 has no axe violations', async () => {
    seed('Art/rex.md');
    const { container } = render(<AppShell />);
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
