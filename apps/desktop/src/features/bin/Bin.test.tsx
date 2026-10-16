import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BinItem } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { DialogHost } from '../dialogs/DialogHost';
import { ArchivedBanner } from './ArchivedBanner';
import { BinView } from './BinView';
import { useBinStore } from './binStore';
import { SidebarFoot } from './SidebarFoot';

type Handler = (args: Record<string, unknown>) => unknown;

const AT = Date.parse('2026-10-15T10:00:00');
const item = (path: string, from: string | null, folder = false): BinItem => ({
  path,
  from,
  at: from ? AT : null,
  folder,
});

let lists: { trash: BinItem[]; archive: BinItem[] };

function backend(extra: Record<string, Handler> = {}) {
  const calls: [string, Record<string, unknown>][] = [];
  const handlers: Record<string, Handler> = {
    bin_list: () => lists,
    vault_tree: () => [],
    trash_restore: (a) => {
      lists.trash = lists.trash.filter((i) => i.path !== a.path);
      return 'P/Old.md';
    },
    trash_delete: (a) => {
      lists.trash = lists.trash.filter((i) => !(a.paths as string[]).includes(i.path));
      return null;
    },
    trash_empty: () => {
      lists.trash = [];
      return null;
    },
    archive_restore: (a) => {
      lists.archive = lists.archive.filter((i) => i.path !== a.path);
      return { moved: [[a.path, 'Camp']], updatedFiles: [], updatedLinks: 0, failed: [] };
    },
    entry_trash: (a) => `.trash/${String(a.path).split('/').pop()}`,
    entry_archive: (a) => ({
      moved: [[a.path, `.archive/${String(a.path)}`]],
      updatedFiles: [],
      updatedLinks: 0,
      failed: [],
    }),
    ...extra,
  };
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

const called = (calls: [string, Record<string, unknown>][], cmd: string) =>
  calls.filter(([c]) => c === cmd).map(([, a]) => a);

beforeEach(() => {
  lists = {
    trash: [item('.trash/Old.md', 'P/Old.md'), item('.trash/Drafts', 'Drafts', true)],
    archive: [item('.archive/Camp', 'Camp', true)],
  };
  useToastStore.getState().clear();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, warning: null, loaded: true });
  useUiStore.setState({ dialog: null, screen: 'edit' });
});

afterEach(async () => {
  await resetVaultStore();
  useBinStore.getState().reset();
  clearMocks();
});

describe('SidebarFoot (M5b §5.2, §5.3)', () => {
  it('shows Archived above Trash with their counts and opens their views', async () => {
    backend();
    render(<SidebarFoot />);
    await act(() => useBinStore.getState().refresh());
    const archived = screen.getByRole('button', { name: 'Archived, 1 item' });
    const trash = screen.getByRole('button', { name: 'Trash, 2 items' });
    expect(archived.compareDocumentPosition(trash) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(trash);
    expect(useUiStore.getState().screen).toBe('trash');
    expect(trash).toHaveAttribute('aria-current', 'page');
    await userEvent.click(archived);
    expect(useUiStore.getState().screen).toBe('archive');
  });
});

describe('BinView: the Trash', () => {
  it('lists items with where they came from, and restores one', async () => {
    const calls = backend();
    render(<BinView kind="trash" />);
    const list = await screen.findByRole('list', { name: 'Trash' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Old');
    expect(rows[0]).toHaveTextContent('P');
    await userEvent.click(within(rows[0]).getByRole('button', { name: 'Restore Old' }));
    expect(called(calls, 'trash_restore')).toEqual([{ path: '.trash/Old.md', keepBoth: false }]);
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
  });

  it('asks to keep both when something took the old place', async () => {
    let clash = true;
    const calls = backend({
      trash_restore: (a) => {
        if (clash && !a.keepBoth) {
          clash = false;
          throw { kind: 'alreadyExists', message: 'P/Old.md' };
        }
        lists.trash = lists.trash.filter((i) => i.path !== a.path);
        return 'P/Old 1.md';
      },
    });
    render(
      <>
        <BinView kind="trash" />
        <DialogHost />
      </>,
    );
    const list = await screen.findByRole('list', { name: 'Trash' });
    await userEvent.click(within(list).getAllByRole('button', { name: 'Restore Old' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Old already exists' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep both' }));
    expect(called(calls, 'trash_restore')).toEqual([
      { path: '.trash/Old.md', keepBoth: false },
      { path: '.trash/Old.md', keepBoth: true },
    ]);
  });

  it('deletes one, then empties the Trash, each after a confirmation naming the count', async () => {
    const calls = backend();
    render(<BinView kind="trash" />);
    const list = await screen.findByRole('list', { name: 'Trash' });
    await userEvent.click(
      within(list).getByRole('button', { name: 'Delete Drafts from the vault' }),
    );
    let dialog = await screen.findByRole('dialog', { name: 'Delete 1 item from the vault?' });
    expect(dialog).toHaveTextContent('system Trash');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(called(calls, 'trash_delete')).toEqual([{ paths: ['.trash/Drafts'] }]);
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));

    await userEvent.click(screen.getByRole('button', { name: 'Empty Trash' }));
    dialog = await screen.findByRole('dialog', { name: 'Empty the Trash (1 item)?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Empty Trash' }));
    expect(called(calls, 'trash_empty')).toHaveLength(1);
    expect(await screen.findByText('The Trash is empty.')).toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    backend();
    render(<BinView kind="trash" />);
    await screen.findByRole('list', { name: 'Trash' });
    const result = await axe.run(document.body);
    expect(result.violations).toEqual([]);
  });
});

describe('BinView: the Archive', () => {
  it('unarchives an item and moves another to the Trash', async () => {
    lists.archive.push(item('.archive/Old.md', 'Old.md'));
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, confirmDelete: false } });
    const calls = backend();
    render(<BinView kind="archive" />);
    const list = await screen.findByRole('list', { name: 'Archived' });
    await userEvent.click(within(list).getByRole('button', { name: 'Unarchive Camp' }));
    expect(called(calls, 'archive_restore')).toEqual([{ path: '.archive/Camp', keepBoth: false }]);
    await userEvent.click(within(list).getByRole('button', { name: 'Move Old to Trash' }));
    expect(called(calls, 'entry_trash')).toEqual([{ path: '.archive/Old.md' }]);
  });
});

describe('moving to the Trash and the Archive', () => {
  it('a trash toast offers Undo, which restores', async () => {
    const calls = backend();
    await useVaultStore.getState().trash('P/Old.md');
    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.message).toBe('Moved to Trash');
    expect(toast?.action?.label).toBe('Undo');
    toast?.action?.run();
    await waitFor(() =>
      expect(called(calls, 'trash_restore')).toEqual([{ path: '.trash/Old.md', keepBoth: false }]),
    );
  });

  it('an archived page shows a banner with Unarchive', async () => {
    const calls = backend();
    render(<ArchivedBanner path=".archive/Camp/a.md" />);
    expect(screen.getByRole('status')).toHaveTextContent('This page is archived.');
    await userEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    expect(called(calls, 'archive_restore')).toEqual([
      { path: '.archive/Camp/a.md', keepBoth: false },
    ]);
  });

  it('no banner outside the Archive', () => {
    backend();
    const { container } = render(<ArchivedBanner path="Camp/a.md" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('M5b final review', () => {
  it('M3: Unarchive from the banner asks to keep both on a clash', async () => {
    const calls = backend({
      archive_restore: (a) => {
        if (!a.keepBoth) throw { kind: 'alreadyExists', message: 'Camp/a.md' };
        return { moved: [[a.path, 'Camp/a 1.md']], updatedFiles: [], updatedLinks: 0, failed: [] };
      },
    });
    render(
      <>
        <ArchivedBanner path=".archive/Camp/a.md" />
        <DialogHost />
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    const dialog = await screen.findByRole('dialog', { name: 'a already exists' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep both' }));
    await waitFor(() =>
      expect(called(calls, 'archive_restore')).toEqual([
        { path: '.archive/Camp/a.md', keepBoth: false },
        { path: '.archive/Camp/a.md', keepBoth: true },
      ]),
    );
  });

  it('M4: Move to Trash from the Archived view asks first', async () => {
    lists.archive.push(item('.archive/Old.md', 'Old.md'));
    const calls = backend();
    render(<BinView kind="archive" />);
    const list = await screen.findByRole('list', { name: 'Archived' });
    await userEvent.click(within(list).getByRole('button', { name: 'Move Old to Trash' }));
    expect(useUiStore.getState().dialog).toEqual({ type: 'delete', path: '.archive/Old.md' });
    expect(called(calls, 'entry_trash')).toEqual([]);
  });

  it("M5: a trash toast's Undo never brings back another item that took the name", async () => {
    const calls = backend();
    await useVaultStore.getState().trash('P/Old.md');
    const undo = useToastStore.getState().toasts.at(-1)?.action;
    // Restored meanwhile, and B/Old.md trashed under the same name.
    lists.trash = [item('.trash/Old.md', 'B/Old.md')];
    undo?.run();
    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
        'That item is no longer in the Trash.',
      ),
    );
    expect(called(calls, 'trash_restore')).toEqual([]);
  });
});
