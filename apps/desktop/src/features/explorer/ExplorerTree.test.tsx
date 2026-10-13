import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TreeNode } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { usePageStore } from '../../stores/pageStore';
import { childrenByParent } from '../../stores/tree';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { ExplorerTree } from './ExplorerTree';

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
