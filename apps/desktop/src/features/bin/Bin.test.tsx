import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BinItem } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { DialogHost } from '../dialogs/DialogHost';
import { ArchivedBanner } from './ArchivedBanner';
import { BinView, resetTrashView } from './BinView';
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
  it('shows Archived above Trash with their counts; Trash opens its view, Archived opens like a folder', async () => {
    backend();
    render(<SidebarFoot />);
    await act(() => useBinStore.getState().refresh());
    const archived = screen.getByRole('button', { name: 'Archived, 1 item' });
    const trash = screen.getByRole('button', { name: 'Trash, 2 items' });
    expect(archived.compareDocumentPosition(trash) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(trash);
    expect(useUiStore.getState().screen).toBe('trash');
    expect(trash).toHaveAttribute('aria-current', 'page');
    // M5b round 2: no Archived view; the row expands in place.
    await userEvent.click(archived);
    expect(useUiStore.getState().screen).toBe('trash');
    expect(archived).toHaveAttribute('aria-expanded', 'true');
  });

  it('holds only Archived and Trash: no privacy line', async () => {
    backend();
    render(<SidebarFoot />);
    await act(() => useBinStore.getState().refresh());
    expect(screen.queryByText('Local only · zero network requests')).not.toBeInTheDocument();
  });
});

describe('BinView: the Trash (M5b round 2 design)', () => {
  const NOW = Date.parse('2026-10-15T18:00:00');
  const at = (iso: string) => Date.parse(iso);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    resetTrashView();
    lists.trash = [
      {
        ...item('.trash/Old.md', 'P/Old.md'),
        at: at('2026-10-15T08:23:00'),
        size: 2048,
        icon: '📝',
      },
      {
        ...item('.trash/Drafts', 'Lore/Drafts', true),
        at: at('2026-10-14T19:51:00'),
        size: 10_000,
        pages: 14,
      },
      { ...item('.trash/map.png', 'World/map.png'), at: at('2026-10-12T18:02:00'), size: 860_160 },
      { ...item('.trash/Spells.md', 'Game/Spells.md'), at: at('2026-10-01T09:00:00'), size: 512 },
    ];
  });
  afterEach(() => vi.useRealTimers());
  const groups = () =>
    screen.getAllByRole('list').map((l) => [
      l.getAttribute('aria-label'),
      within(l)
        .getAllByRole('listitem')
        .map((r) => r.querySelector('[data-name]')?.textContent),
    ]);

  it('says how many items and how much space, grouped by the day they were deleted', async () => {
    backend();
    render(<BinView />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Trash' })).toBeInTheDocument();
    expect(
      screen.getByText(/^4 items · 852 kB\. They stay inside the vault until you delete them/),
    ).toBeInTheDocument();
    expect(groups()).toEqual([
      ['Today', ['Old']],
      ['Yesterday', ['Drafts']],
      ['Earlier this week', ['map.png']],
      ['Oct 1, 2026', ['Spells']],
    ]);
    const old = screen.getByRole('listitem', { name: 'Old' });
    expect(old).toHaveTextContent('Page · from P · deleted 8:23 AM');
    expect(old).toHaveTextContent('📝');
    expect(screen.getByRole('listitem', { name: 'Drafts' })).toHaveTextContent(
      'Folder · 14 pages · from Lore',
    );
    expect(screen.getByRole('listitem', { name: 'map.png' })).toHaveTextContent(
      'Image · 840 kB · from World',
    );
    expect(screen.getByRole('button', { name: 'Restore Old' })).toHaveAttribute(
      'title',
      'Restore to P',
    );
  });

  it('filters by name or folder, and sorts (remembered for the session)', async () => {
    backend();
    const { unmount } = render(<BinView />);
    await screen.findByRole('heading', { level: 1, name: 'Trash' });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter the Trash' }), 'lore');
    expect(groups()).toEqual([['Yesterday', ['Drafts']]]);
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Filter the Trash' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'name');
    expect(groups()).toEqual([['All items', ['Drafts', 'map.png', 'Old', 'Spells']]]);
    unmount();
    render(<BinView />);
    await screen.findByRole('heading', { level: 1, name: 'Trash' });
    expect(screen.getByRole('combobox', { name: 'Sort' })).toHaveValue('name');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'oldest');
    expect(groups().map(([g]) => g)).toEqual([
      'Oct 1, 2026',
      'Earlier this week',
      'Yesterday',
      'Today',
    ]);
  });

  it('restores and deletes several at once from the selection bar; Escape clears it', async () => {
    const calls = backend();
    render(
      <>
        <BinView />
        <DialogHost />
      </>,
    );
    await screen.findByRole('heading', { level: 1, name: 'Trash' });
    expect(screen.queryByRole('region', { name: 'Selection' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Old' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Drafts' }));
    const bar = screen.getByRole('region', { name: 'Selection' });
    expect(bar).toHaveTextContent('2 selected');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Selection' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Old' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Drafts' }));
    await userEvent.click(
      within(screen.getByRole('region', { name: 'Selection' })).getByRole('button', {
        name: 'Restore',
      }),
    );
    await waitFor(() =>
      expect(called(calls, 'trash_restore')).toEqual([
        { path: '.trash/Old.md', keepBoth: false },
        { path: '.trash/Drafts', keepBoth: false },
      ]),
    );

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select map.png' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Spells' }));
    await userEvent.click(
      within(screen.getByRole('region', { name: 'Selection' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Delete 2 items from the vault?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(called(calls, 'trash_delete')).toEqual([
      { paths: ['.trash/map.png', '.trash/Spells.md'] },
    ]);
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
        <BinView />
        <DialogHost />
      </>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Restore Old' }));
    const dialog = await screen.findByRole('dialog', { name: 'Old already exists' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep both' }));
    expect(called(calls, 'trash_restore')).toEqual([
      { path: '.trash/Old.md', keepBoth: false },
      { path: '.trash/Old.md', keepBoth: true },
    ]);
  });

  it('round-2 review I2: a bulk restore asks about each clash in turn, and waits', async () => {
    const asked = new Set<string>();
    const calls = backend({
      trash_restore: (a) => {
        if (!a.keepBoth && !asked.has(String(a.path))) {
          asked.add(String(a.path));
          throw { kind: 'alreadyExists', message: String(a.path) };
        }
        lists.trash = lists.trash.filter((i) => i.path !== a.path);
        return 'x';
      },
    });
    render(
      <>
        <BinView />
        <DialogHost />
      </>,
    );
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select Old' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Drafts' }));
    const bar = screen.getByRole('region', { name: 'Selection' });
    await userEvent.click(within(bar).getByRole('button', { name: 'Restore' }));
    const first = await screen.findByRole('dialog', { name: 'Old already exists' });
    // While it runs, the selection can't start a second action.
    expect(within(bar).getByRole('button', { name: 'Restore' })).toBeDisabled();
    expect(within(bar).getByRole('button', { name: 'Delete' })).toBeDisabled();
    await userEvent.click(within(first).getByRole('button', { name: 'Keep both' }));
    const second = await screen.findByRole('dialog', { name: 'Drafts already exists' });
    await userEvent.click(within(second).getByRole('button', { name: 'Keep both' }));
    await waitFor(() =>
      expect(called(calls, 'trash_restore')).toEqual([
        { path: '.trash/Old.md', keepBoth: false },
        { path: '.trash/Old.md', keepBoth: true },
        { path: '.trash/Drafts', keepBoth: false },
        { path: '.trash/Drafts', keepBoth: true },
      ]),
    );
  });

  it('deletes one, then empties the Trash, each after a confirmation naming the count', async () => {
    lists.trash = lists.trash.slice(0, 2);
    const calls = backend();
    render(<BinView />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Delete Drafts from the vault' }),
    );
    let dialog = await screen.findByRole('dialog', { name: 'Delete 1 item from the vault?' });
    expect(dialog).toHaveTextContent('system Trash');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(called(calls, 'trash_delete')).toEqual([{ paths: ['.trash/Drafts'] }]);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));

    await userEvent.click(screen.getByRole('button', { name: 'Empty Trash' }));
    dialog = await screen.findByRole('dialog', { name: 'Empty the Trash (1 item)?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Empty Trash' }));
    expect(called(calls, 'trash_empty')).toHaveLength(1);
    expect(await screen.findByRole('heading', { name: 'The Trash is empty' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Empty Trash' })).not.toBeInTheDocument();
  });

  it('is axe-clean, light and dark', async () => {
    backend();
    render(<BinView />);
    await screen.findByRole('heading', { level: 1, name: 'Trash' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Old' }));
    for (const theme of ['light', 'dark']) {
      document.documentElement.dataset.theme = theme;
      expect((await axe.run(document.body)).violations).toEqual([]);
    }
    delete document.documentElement.dataset.theme;
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
