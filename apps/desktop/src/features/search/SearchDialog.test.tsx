import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchHit, SearchPage, SearchQuery } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { useGvStore } from '../global-view/gvStore';
import { ActionButton } from '../shell/ActionButton';
import { isSearchKey, useGlobalShortcuts } from '../shell/useGlobalShortcuts';
import { DialogHost } from '../dialogs/DialogHost';
import { useSearchStore } from './searchStore';

const opened = vi.hoisted(() => [] as string[]);
vi.mock('../../stores/navigate', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openPage: async (path: string) => void opened.push(path),
}));

const hit = (path: string, more: Partial<SearchHit> = {}): SearchHit => ({
  path,
  title: path.split('/').pop()!.replace(/\.md$/, ''),
  cover: null,
  tags: [],
  hasImage: false,
  hasAudio: false,
  snippet: null,
  ...more,
});

const FACETS = {
  projects: [
    { value: 'Lore', count: 2 },
    { value: 'Game', count: 1 },
  ],
  tags: [{ value: 'lore', count: 2 }],
  linksTo: [{ path: 'Lore/Smaug.md', title: 'Smaug', count: 1, active: false }],
  linksFrom: null,
  hasImage: 1,
  hasAudio: 0,
  archived: 2,
};

let queries: SearchQuery[];
let reply: (q: SearchQuery) => SearchPage;

const defaultReply = (q: SearchQuery): SearchPage => {
  const text = q.text ?? '';
  const filtered = !!(q.project || q.folder || q.tags?.length || q.linksTo || q.linksFrom);
  if (!text && !filtered && !q.hasImage)
    return { results: [hit('Recent.md')], total: 1, facets: FACETS, recent: true, indexing: false };
  const results = text.toLowerCase().startsWith('drag')
    ? [
        hit('Lore/Canción del dragón.md', {
          tags: ['lore'],
          hasImage: true,
          snippet: [
            { text: '…the ', hit: false },
            { text: 'dragon', hit: true },
            { text: ' sleeps <b>here</b>', hit: false },
          ],
        }),
        hit('Game/Dragon run.md', { cover: 'Game/c.png' }),
      ]
    : [hit('Lore/Smaug.md')];
  const linksTo = q.linksTo
    ? [{ path: 'Chars/Rex.md', title: 'Rex the Great', count: results.length, active: true }]
    : FACETS.linksTo;
  return {
    results,
    total: results.length,
    facets: { ...FACETS, linksTo },
    recent: false,
    indexing: false,
  };
};

beforeEach(() => {
  queries = [];
  opened.length = 0;
  reply = defaultReply;
  useSearchStore.getState().reset();
  useUiStore.setState({ dialog: null, screen: 'edit' });
  useVaultStore.setState({ status: 'open', nodes: [] });
  mockIPC((cmd, raw) => {
    if (cmd !== 'search') return null;
    const q = (raw as { query: SearchQuery }).query;
    queries.push(q);
    return reply(q);
  });
});
afterEach(() => clearMocks());

function openDialog() {
  render(<DialogHost />);
  act(() => useUiStore.getState().openDialog({ type: 'search' }));
  return screen.getByRole('combobox', { name: 'Search the vault' });
}

const lastQuery = () => queries[queries.length - 1];

describe('Search dialog (M5 §4)', () => {
  it('shows a hit’s emoji before its title (M5b §4)', async () => {
    useVaultStore.setState({ nodes: [{ path: 'Recent.md', kind: 'page', icon: '🚀' }] });
    openDialog();
    expect(await screen.findByRole('option', { name: /Recent/ })).toHaveTextContent(/🚀Recent/);
  });

  it('opens with the keyboard in the field and shows Recent', async () => {
    const field = openDialog();
    expect(field).toHaveFocus();
    expect(screen.getByRole('dialog', { name: 'Search' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Recent' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Recent/ })).toBeInTheDocument();
  });

  it('types, moves with ↓/↑, opens with Enter and closes', async () => {
    const field = openDialog();
    await userEvent.type(field, 'drag');
    const list = await screen.findByRole('listbox', { name: 'Results' });
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(2));
    expect(screen.getByText('2 results')).toBeInTheDocument();
    const options = within(list).getAllByRole('option');
    expect(field).toHaveAttribute('aria-activedescendant', options[0].id);
    await userEvent.keyboard('{ArrowDown}');
    expect(field).toHaveAttribute('aria-activedescendant', options[1].id);
    await userEvent.keyboard('{ArrowDown}{ArrowUp}');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Enter}');
    expect(opened).toEqual(['Lore/Canción del dragón.md']);
    expect(useUiStore.getState().dialog).toBeNull();
  });

  it('Enter right after typing opens a hit of the text typed, never an older one (final review I2)', async () => {
    const field = openDialog();
    await screen.findByRole('option', { name: /Recent/ });
    // Paste and press Enter before the debounce fires.
    fireEvent.change(field, { target: { value: 'drag' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(opened).toEqual(['Lore/Canción del dragón.md']));
  });

  it('a tag written decomposed counts as the same chip (final review M2)', async () => {
    reply = (q) => ({
      ...defaultReply(q),
      facets: { ...FACETS, tags: [{ value: 'cancio\u0301n', count: 1 }] },
    });
    const field = openDialog();
    await userEvent.type(field, '#canción ');
    const chip = await screen.findByRole('button', { name: /#cancio\u0301n/ });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(chip);
    expect(lastQuery().tags).toEqual([]);
  });

  it('Shift+Enter shows the page level in the Global View', async () => {
    const showPage = vi.fn(async () => undefined);
    useGvStore.setState({ showPage });
    const field = openDialog();
    await userEvent.type(field, 'drag');
    await screen.findAllByRole('option', { name: /Dragon run/ });
    await userEvent.keyboard('{ArrowDown}{Shift>}{Enter}{/Shift}');
    expect(showPage).toHaveBeenCalledWith('Game/Dragon run.md', 'Dragon run');
    expect(useUiStore.getState().screen).toBe('global');
    expect(opened).toEqual([]);
  });

  it('highlights titles and snippets with marks, never HTML', async () => {
    const field = openDialog();
    await userEvent.type(field, 'drag');
    const option = await screen.findByRole('option', { name: /Canción/ });
    const marks = [...option.querySelectorAll('mark')].map((m) => m.textContent);
    expect(marks).toEqual(['drag', 'dragon']);
    expect(option.querySelector('b')).toBeNull();
    expect(option).toHaveTextContent('sleeps <b>here</b>');
    expect(within(option).getByRole('img', { name: 'Has image' })).toBeInTheDocument();
    expect(within(option).getByText('Lore › Canción del dragón.md')).toBeInTheDocument();
  });

  it('project, tag, links-to and media chips toggle and send their filter', async () => {
    openDialog();
    const project = within(await screen.findByRole('group', { name: 'Project' })).getByRole(
      'button',
      { name: /Lore/ },
    );
    await userEvent.click(project);
    expect(lastQuery()).toMatchObject({ project: 'Lore' });
    await waitFor(() => expect(project).toHaveAttribute('aria-pressed', 'true'));
    await userEvent.click(project);
    expect(lastQuery()).toMatchObject({ project: null });

    await userEvent.click(
      within(screen.getByRole('group', { name: 'Tags' })).getByRole('button', { name: /#lore/ }),
    );
    expect(lastQuery()).toMatchObject({ tags: ['lore'] });
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Links to' })).getByRole('button', {
        name: /Smaug/,
      }),
    );
    expect(lastQuery()).toMatchObject({ linksTo: 'Lore/Smaug.md' });
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Show' })).getByRole('button', {
        name: /Has image/,
      }),
    );
    expect(lastQuery()).toMatchObject({ tags: ['lore'], hasImage: true });
    // M5b §5.3: archived pages only when asked for, counted either way.
    expect(lastQuery().archived).toBe(false);
    const archived = within(screen.getByRole('group', { name: 'Show' })).getByRole('button', {
      name: /Archived/,
    });
    expect(archived).toHaveTextContent('2');
    await userEvent.click(archived);
    expect(lastQuery()).toMatchObject({ hasImage: true, archived: true });
  });

  it('active filters show as removable chips; Clear all and Backspace remove them', async () => {
    const field = openDialog();
    act(() => useSearchStore.getState().setFilters({ tags: ['lore'], folder: 'Places' }));
    const active = await screen.findByRole('group', { name: 'Active' });
    expect(within(active).getByRole('button', { name: 'Remove filter In: Places' })).toBeVisible();
    await userEvent.click(within(active).getByRole('button', { name: 'Remove filter #lore' }));
    expect(lastQuery()).toMatchObject({ tags: [], folder: 'Places' });
    field.focus();
    await userEvent.keyboard('{Backspace}');
    expect(lastQuery()).toMatchObject({ folder: null });
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Active' })).toBeNull());
    act(() => useSearchStore.getState().setFilters({ tags: ['a'], hasAudio: true }));
    await userEvent.click(await screen.findByRole('button', { name: 'Clear all' }));
    expect(lastQuery()).toMatchObject({ tags: [], hasAudio: false });
  });

  it('filter words become chips: #tag + Space, to:Name + Enter (which opens nothing)', async () => {
    const field = openDialog();
    await userEvent.type(field, 'red #lore ');
    expect(field).toHaveValue('red ');
    expect(lastQuery()).toMatchObject({ tags: ['lore'] });
    await userEvent.clear(field);
    await userEvent.type(field, 'to:Rex{Enter}');
    expect(field).toHaveValue('');
    expect(lastQuery()).toMatchObject({ linksTo: 'Rex' });
    expect(opened).toEqual([]);
    expect(
      await screen.findByRole('button', { name: 'Remove filter Links to: Rex the Great' }),
    ).toBeInTheDocument();
  });

  it('Escape clears the text first, then closes and gives focus back', async () => {
    const before = document.createElement('button');
    document.body.appendChild(before);
    before.focus();
    const field = openDialog();
    await userEvent.type(field, 'drag');
    await userEvent.keyboard('{Escape}');
    expect(field).toHaveValue('');
    expect(useUiStore.getState().dialog).toEqual({ type: 'search' });
    await userEvent.keyboard('{Escape}');
    expect(useUiStore.getState().dialog).toBeNull();
    expect(before).toHaveFocus();
    before.remove();
  });

  it('keeps the last query for the next opening, selected', async () => {
    const field = openDialog();
    await userEvent.type(field, 'drag');
    act(() => useUiStore.getState().closeDialog());
    act(() => useUiStore.getState().openDialog({ type: 'search' }));
    const again = screen.getByRole('combobox', { name: 'Search the vault' }) as HTMLInputElement;
    expect(again.value).toBe('drag');
    expect([again.selectionStart, again.selectionEnd]).toEqual([0, 4]);
  });

  it('announces the count politely', async () => {
    const field = openDialog();
    await userEvent.type(field, 'drag');
    const status = screen.getByRole('status');
    await waitFor(() => expect(status).toHaveTextContent('2 results'), { timeout: 2000 });
  });

  it('says when indexing is still running, and when nothing matches', async () => {
    reply = (q) => ({ ...defaultReply(q), indexing: true, results: [], total: 0 });
    const field = openDialog();
    await userEvent.type(field, 'zzz');
    expect(await screen.findByText('Still indexing: results may be incomplete.')).toBeVisible();
    expect(screen.getByText('Nothing matches.')).toBeVisible();
  });

  it('Show more loads the next page', async () => {
    reply = (q) => ({
      ...defaultReply(q),
      results: [hit(q.offset ? 'More.md' : 'First.md')],
      total: 2,
      recent: false,
    });
    const field = openDialog();
    await userEvent.type(field, 'p');
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(lastQuery().offset).toBe(1);
    expect(await screen.findByRole('option', { name: /More/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('has no axe violations, light or dark', async () => {
    const field = openDialog();
    act(() => useSearchStore.getState().setFilters({ tags: ['lore'] }));
    await userEvent.type(field, 'drag');
    await screen.findAllByRole('option');
    for (const theme of ['light', 'dark']) {
      document.documentElement.dataset.theme = theme;
      const violations = await axe
        .run(screen.getByRole('dialog'), { rules: { 'color-contrast': { enabled: false } } })
        .then((r) => r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`));
      expect(violations).toEqual([]);
    }
    delete document.documentElement.dataset.theme;
  });
});

describe('opening Search (M5 §4)', () => {
  function Shortcuts() {
    useGlobalShortcuts(false);
    return null;
  }

  it('⌘⇧F and Ctrl+Shift+F, also on layouts without a Latin F', () => {
    const key = (init: KeyboardEventInit) => isSearchKey(new KeyboardEvent('keydown', init));
    expect(key({ metaKey: true, shiftKey: true, key: 'F', code: 'KeyF' })).toBe(true);
    expect(key({ ctrlKey: true, shiftKey: true, key: 'f', code: 'KeyF' })).toBe(true);
    expect(key({ metaKey: true, shiftKey: true, key: 'А', code: 'KeyF' })).toBe(true);
    expect(key({ metaKey: true, key: 'f', code: 'KeyF' })).toBe(false);
    expect(key({ metaKey: true, shiftKey: true, altKey: true, key: 'f', code: 'KeyF' })).toBe(
      false,
    );
    // Dvorak: the key that types F sits elsewhere; its letter wins.
    expect(key({ metaKey: true, shiftKey: true, key: 'u', code: 'KeyF' })).toBe(false);

    render(<Shortcuts />);
    fireEvent.keyDown(document.body, { metaKey: true, shiftKey: true, key: 'F', code: 'KeyF' });
    expect(useUiStore.getState().dialog).toEqual({ type: 'search' });
  });

  it('the floating button has Search with its shortcut (M5b §2.2)', async () => {
    render(<ActionButton />);
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const button = screen.getByRole('button', { name: 'Search' });
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Meta+F Control+F');
    await userEvent.click(button);
    expect(useUiStore.getState().dialog).toEqual({ type: 'search' });
  });
});
