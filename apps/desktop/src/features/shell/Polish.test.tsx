// M1b hand-off §10 items a–f (M2a spec §6).
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../app/App';
import type { TreeNode } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { resetEditorStore, useEditorStore } from '../../stores/editorStore';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { childrenByParent } from '../../stores/tree';
import { useUiStore } from '../../stores/uiStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { AppShell } from './AppShell';

const nodes: TreeNode[] = [
  { path: 'Art', kind: 'folder' },
  { path: 'Art/rex.md', kind: 'page' },
  { path: 'My Notes.md', kind: 'page' },
  { path: 'Welcome.md', kind: 'page' },
];
const info = (name: string) => ({
  name,
  root: `/${name}`,
  report: {
    files: 1,
    pages: 1,
    parsed: 1,
    skippedUnchanged: 0,
    removed: 0,
    warnings: [],
    durationMs: 1,
  },
});

function backend(handlers: Record<string, (a: Record<string, unknown>) => unknown>) {
  const calls: [string, Record<string, unknown>][] = [];
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push([cmd, a]);
      return handlers[cmd]?.(a);
    },
    { shouldMockEvents: true },
  );
  return calls;
}

function seed() {
  act(() =>
    useVaultStore.setState({
      status: 'open',
      info: info('A'),
      nodes,
      children: childrenByParent(nodes),
    }),
  );
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

afterEach(async () => {
  resetEditorStore();
  usePageStore.getState().clear();
  await resetVaultStore();
  useUiStore.getState().closeDialog();
  useToastStore.getState().clear();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  clearMocks();
});

describe('M1b polish (M2a §6)', () => {
  it('a: a failed switch keeps the current vault open', async () => {
    backend({
      vault_open: () => {
        throw { kind: 'notFound', message: '/B' };
      },
      vault_tree: () => nodes,
    });
    seed();
    const res = await act(() => useVaultStore.getState().open('/B'));
    expect(res.ok).toBe(false);
    expect(useVaultStore.getState().status).toBe('open');
    expect(useVaultStore.getState().info?.name).toBe('A');
    expect(useToastStore.getState().toasts[0].message).toBe('Not found.');
  });

  it('a: switching vaults saves open pages first; an unsaveable page blocks the switch', async () => {
    const files: Record<string, string> = { 'Welcome.md': 'hi\n' };
    let failWrites = false;
    const calls = backend({
      vault_tree: () => nodes,
      page_get: (a) => ({ path: a.path, title: 'Welcome', tags: [], links: 0, backlinks: 0 }),
      page_read: (a) => ({ text: files[a.path as string], hash: 'h1' }),
      page_write: (a) => {
        if (failWrites) throw { kind: 'io', message: 'disk full' };
        files[a.path as string] = a.text as string;
        return { hash: 'h2' };
      },
      vault_open: () => info('B'),
    });
    seed();
    await act(() => usePageStore.getState().load('Welcome.md'));
    useEditorStore.getState().doc!.edit('hi there\n');
    await act(() => useVaultStore.getState().open('/B'));
    const order = calls.map(([c]) => c);
    expect(order.indexOf('page_write')).toBeLessThan(order.indexOf('vault_open'));
    expect(files['Welcome.md']).toBe('hi there\n');
    expect(useEditorStore.getState().doc).toBeNull();

    // Now a page that can't be saved: the switch is refused, the text stays.
    await act(() => usePageStore.getState().load('Welcome.md'));
    failWrites = true;
    useEditorStore.getState().doc!.edit('unsaved\n');
    const opens = order.filter((c) => c === 'vault_open').length;
    const res = await act(() => useVaultStore.getState().open('/C'));
    expect(res.ok).toBe(false);
    expect(calls.filter(([c]) => c === 'vault_open')).toHaveLength(opens);
    expect(useEditorStore.getState().doc?.text).toBe('unsaved\n');
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
      'Unsaved changes in “Welcome” couldn’t be written, so the vault stays open.',
    );
  });

  it('b: Welcome is inert while opening and a second open is refused', async () => {
    const pending = deferred<unknown>();
    const calls = backend({ vault_open: () => pending.promise, vaults_recent: () => [] });
    render(<App />);
    let first!: Promise<unknown>;
    act(() => {
      first = useVaultStore.getState().open('/A');
    });
    expect(screen.getByRole('main', { hidden: true })).toHaveAttribute('inert');
    const second = await act(() => useVaultStore.getState().open('/B'));
    expect(second.ok).toBe(false);
    expect(calls.filter(([c]) => c === 'vault_open')).toHaveLength(1);
    pending.resolve(info('A'));
    await act(() => first);
  });

  it('c: the delete dialog focuses its confirm button and Enter confirms', async () => {
    const calls = backend({ backlink_count: () => 0, vault_tree: () => nodes });
    seed();
    render(<AppShell />);
    screen.getByRole('treeitem', { name: 'Welcome' }).focus();
    await userEvent.keyboard('{Delete}');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Move to Trash' })).toHaveFocus();
    within(dialog).getByRole('checkbox').focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(calls.map(([c]) => c)).toContain('entry_trash'));
  });

  it('d: a "…" button on each row opens its context menu', async () => {
    backend({});
    seed();
    render(<AppShell />);
    const row = screen.getByRole('treeitem', { name: 'Welcome' });
    await userEvent.click(within(row).getByRole('button', { name: 'Actions for Welcome' }));
    expect(screen.getByRole('menu', { name: 'Actions for Welcome' })).toBeInTheDocument();
    expect(useVaultStore.getState().selected).not.toBe('Welcome.md'); // the row wasn't activated
  });

  it('e: the inline-rename error id is a safe generated id', async () => {
    backend({});
    seed();
    render(<AppShell />);
    act(() => useVaultStore.getState().startRename('My Notes.md'));
    const input = screen.getByRole('textbox', { name: 'Rename' });
    await userEvent.clear(input);
    await userEvent.type(input, '.hidden');
    const id = input.getAttribute('aria-describedby')!;
    expect(id).not.toMatch(/\s|Notes/);
    expect(document.getElementById(id)).toHaveTextContent("Names can't start with a dot.");
  });

  it('f: the recent list reloads after a failed open (missing flag)', async () => {
    let missing = false;
    backend({
      vaults_recent: () => [{ path: '/gone', name: 'gone', openedAt: '', missing }],
      vault_open: () => {
        missing = true;
        throw { kind: 'notFound', message: '/gone' };
      },
    });
    render(<App />);
    const open = await screen.findByRole('button', { name: /^gone/ });
    await userEvent.click(open);
    await waitFor(() => expect(screen.getByRole('button', { name: /^gone/ })).toBeDisabled());
    expect(screen.getByText('Folder not found')).toBeInTheDocument();
  });
});
