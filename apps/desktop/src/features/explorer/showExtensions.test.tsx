// Settings → Files → Show file extensions: file names with their extension
// where the UI names a file; off, pages without `.md` as before. Renaming
// never edits a page's `.md`.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeNode } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { childrenByParent, shownName } from '../../stores/tree';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { Breadcrumb } from '../page/Breadcrumb';
import { MoveToDialog } from '../dialogs/MoveToDialog';
import { ExplorerTree } from './ExplorerTree';
import { displayName } from './TreeRow';

const nodes: TreeNode[] = [
  { path: 'Book', kind: 'folder' },
  { path: 'Book/Chapter 1.md', kind: 'page' },
  { path: 'Book/notes.txt', kind: 'attachment' },
  { path: 'Book/cover.png', kind: 'attachment' },
  { path: 'Drafts', kind: 'folder' },
  { path: 'Welcome.md', kind: 'page' },
];

function seed(extra: Partial<ReturnType<typeof useVaultStore.getState>> = {}) {
  useVaultStore.setState({
    status: 'open',
    nodes,
    children: childrenByParent(nodes),
    expanded: new Set(['Book']),
    selected: null,
    renaming: null,
    ...extra,
  });
}

const showExtensions = (on: boolean) =>
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, showExtensions: on } });

const rowNames = () => screen.getAllByRole('treeitem').map((i) => i.getAttribute('data-name'));

beforeEach(() => showExtensions(false));

afterEach(async () => {
  await resetVaultStore();
  clearMocks();
  showExtensions(false);
});

describe('the names helpers', () => {
  it('drop a page’s .md unless extensions show; other files keep theirs', () => {
    expect(shownName('Book/Chapter 1.md', false)).toBe('Chapter 1');
    expect(shownName('Book/Chapter 1.md', true)).toBe('Chapter 1.md');
    expect(shownName('Book/notes.txt', false)).toBe('notes.txt');
    expect(shownName('Book/cover.png', true)).toBe('cover.png');
    const page = { path: 'Book/Chapter 1.MD', kind: 'page' } as const;
    expect(displayName(page, false)).toBe('Chapter 1');
    expect(displayName(page, true)).toBe('Chapter 1.MD');
    expect(displayName({ path: 'Book', kind: 'folder' }, true)).toBe('Book');
  });
});

describe('the sidebar tree', () => {
  it('off (the default): pages without .md, other files with their extension', () => {
    expect(DEFAULT_SETTINGS.showExtensions).toBe(false);
    seed();
    render(<ExplorerTree />);
    expect(rowNames()).toEqual([
      'Book',
      'Chapter 1',
      'notes.txt',
      'cover.png',
      'Drafts',
      'Welcome',
    ]);
    expect(screen.getByRole('treeitem', { name: 'Chapter 1' })).toHaveTextContent('Chapter 1');
  });

  it('on: every file with its extension, and back off at once', () => {
    seed();
    showExtensions(true);
    const { rerender } = render(<ExplorerTree />);
    expect(rowNames()).toEqual([
      'Book',
      'Chapter 1.md',
      'notes.txt',
      'cover.png',
      'Drafts',
      'Welcome.md',
    ]);
    expect(screen.getByRole('treeitem', { name: 'Chapter 1.md' })).toHaveTextContent(
      'Chapter 1.md',
    );
    showExtensions(false);
    rerender(<ExplorerTree />);
    expect(rowNames()).toContain('Chapter 1');
  });

  it('renaming a page with extensions on edits the name; the .md stays outside the field', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'entry_rename')
        return { moved: [], updatedFiles: [], updatedLinks: 0, failed: [] };
      if (cmd === 'vault_tree') return nodes;
      return null;
    });
    seed();
    showExtensions(true);
    render(<ExplorerTree />);
    screen.getByRole('treeitem', { name: 'Chapter 1.md' }).focus();
    await userEvent.keyboard('{F2}');
    const input = screen.getByRole('textbox', { name: 'Rename' });
    expect(input).toHaveValue('Chapter 1');
    const ext = input.parentElement!.querySelector('[data-rename-ext]');
    expect(ext).toHaveTextContent('.md');
    await userEvent.clear(input);
    await userEvent.type(input, 'Opening{Enter}');
    await waitFor(() =>
      expect(calls.find(([c]) => c === 'entry_rename')?.[1]).toEqual({
        from: 'Book/Chapter 1.md',
        to: 'Book/Opening.md',
      }),
    );
  });

  it('renaming a page with extensions off works as before (no suffix shown)', async () => {
    seed({ renaming: 'Welcome.md' });
    render(<ExplorerTree />);
    const input = screen.getByRole('textbox', { name: 'Rename' });
    expect(input).toHaveValue('Welcome');
    expect(document.querySelector('[data-rename-ext]')).toBeNull();
  });

  it('a text file is renamed by its whole name, as before, either way', () => {
    seed({ renaming: 'Book/notes.txt' });
    showExtensions(true);
    render(<ExplorerTree />);
    expect(screen.getByRole('textbox', { name: 'Rename' })).toHaveValue('notes.txt');
    expect(document.querySelector('[data-rename-ext]')).toBeNull();
  });
});

describe('Move to…', () => {
  const tree = () => screen.getByRole('tree', { name: 'Destination folder' });

  beforeEach(() => {
    useVaultStore.setState({ nodes, rename: vi.fn() } as never);
  });

  it('off: the page targets and the title without .md', () => {
    render(<MoveToDialog path="Book/notes.txt" onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toHaveAccessibleName(/notes\.txt/);
    expect(within(tree()).getByRole('treeitem', { name: /^Welcome$/ })).toBeInTheDocument();
  });

  it('on: names with their extension, the title too', () => {
    showExtensions(true);
    render(<MoveToDialog path="Book/Chapter 1.md" onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toHaveAccessibleName(/Chapter 1\.md/);
    expect(within(tree()).getByRole('treeitem', { name: /^Welcome\.md$/ })).toBeInTheDocument();
  });
});

describe('the breadcrumb', () => {
  it('names the page’s file with its extension only when they show', () => {
    useVaultStore.setState({
      info: { name: 'Vault' } as never,
      children: childrenByParent(nodes),
    });
    const { rerender } = render(<Breadcrumb path="Book/Chapter 1.md" />);
    const crumbs = () => screen.getByRole('navigation').textContent;
    expect(crumbs()).toContain('Chapter 1');
    expect(crumbs()).not.toContain('Chapter 1.md');
    showExtensions(true);
    rerender(<Breadcrumb path="Book/Chapter 1.md" />);
    expect(crumbs()).toContain('Chapter 1.md');
  });
});
