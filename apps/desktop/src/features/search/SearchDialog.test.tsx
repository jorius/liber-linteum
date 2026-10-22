import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchHit, SearchPage, SearchQuery } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { useGvStore } from '../global-view/gvStore';
import { ActionButton } from '../shell/ActionButton';
import { installNoFindBar, isSearchKey, useGlobalShortcuts } from '../shell/useGlobalShortcuts';
import { DialogHost } from '../dialogs/DialogHost';
import { openSearch } from './searchMenu';
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
  textFiles: 3,
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
  // Round 3b §8.2: the icon box shows the page's icon; the title doesn't repeat it.
  const box = (option: HTMLElement) => option.firstElementChild as HTMLElement;
  const titleOf = (option: HTMLElement) =>
    (option.children[1] as HTMLElement).firstElementChild as HTMLElement;

  it('shows a hit’s emoji in its icon box, not before its title (round 3b §8.2)', async () => {
    useVaultStore.setState({ nodes: [{ path: 'Recent.md', kind: 'page', icon: '🚀' }] });
    openDialog();
    const option = await screen.findByRole('option', { name: /Recent/ });
    expect(box(option)).toHaveTextContent('🚀');
    expect(titleOf(option).textContent).toBe('Recent');
  });

  it('the icon wins over the cover; a cover alone still shows; neither shows the page glyph', async () => {
    useVaultStore.setState({ nodes: [{ path: 'Game/Dragon run.md', kind: 'page', icon: '🐉' }] });
    const field = openDialog();
    await userEvent.type(field, 'drag');
    const iconed = await screen.findByRole('option', { name: /Dragon run/ });
    expect(box(iconed)).toHaveTextContent('🐉');
    expect(box(iconed).querySelector('img')).toBeNull();
    act(() => useVaultStore.setState({ nodes: [] }));
    await waitFor(() => expect(box(iconed).querySelector('img')).not.toBeNull());
    const plain = screen.getByRole('option', { name: /Canción/ });
    expect(box(plain).querySelector('svg')).not.toBeNull();
  });

  it('Show file extensions: a hit’s file name shows its extension either way, its title never', async () => {
    // The path line already named the file in full before the setting
    // (`Lore › Smaug.md`, a text file's title is its name): off stays exactly
    // so, and on has nothing to add; the page title keeps no extension.
    for (const on of [false, true]) {
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, showExtensions: on } });
      reply = () => ({
        results: [hit('Lore/Smaug.md'), hit('Lore/notes.txt', { title: 'notes.txt' })],
        total: 2,
        facets: FACETS,
        recent: true,
        indexing: false,
      });
      const { unmount } = render(<DialogHost />);
      act(() => useUiStore.getState().openDialog({ type: 'search' }));
      const page = await screen.findByRole('option', { name: /Smaug/ });
      expect(titleOf(page).textContent).toBe('Smaug');
      expect(page).toHaveTextContent('Lore › Smaug.md');
      expect(screen.getByRole('option', { name: /notes/ })).toHaveTextContent('Lore › notes.txt');
      act(() => useUiStore.getState().closeDialog());
      unmount();
    }
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
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

  it('opens a result at the word its snippet matched; without a snippet, at the top', async () => {
    usePageStore.setState({ jump: null });
    const field = openDialog();
    await userEvent.type(field, 'drag');
    await screen.findByRole('option', { name: /Canción del dragón/ });
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(usePageStore.getState().jump).toMatchObject({
        path: 'Lore/Canción del dragón.md',
        find: 'dragon',
      }),
    );

    usePageStore.setState({ jump: null });
    await act(() => openSearch());
    await userEvent.click(await screen.findByRole('option', { name: /Dragon run/ }));
    await waitFor(() => expect(opened).toContain('Game/Dragon run.md'));
    expect(usePageStore.getState().jump).toBeNull();
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

  it('batch 6: a text file hit shows its type and opens in the text view, Shift+Enter too', async () => {
    const showPage = vi.fn(async () => undefined);
    useGvStore.setState({ showPage });
    reply = (q) => ({
      results: q.text ? [hit('Notes/todo.txt', { title: 'todo.txt' })] : [hit('Recent.md')],
      total: 1,
      facets: FACETS,
      recent: !q.text,
      indexing: false,
    });
    const field = openDialog();
    await userEvent.type(field, 'todo');
    const option = await screen.findByRole('option', { name: /todo\.txt/ });
    expect(within(option).getByText('TXT')).toBeInTheDocument();
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expect(showPage).not.toHaveBeenCalled();
    expect(opened).toEqual(['Notes/todo.txt']);
  });

  it('batch 6: the Text files chip narrows to text files and shows their count', async () => {
    openDialog();
    const chip = await within(await screen.findByRole('group', { name: 'Show' })).findByRole(
      'button',
      { name: /Text files/ },
    );
    expect(chip).toHaveTextContent('3');
    expect(lastQuery().textFiles).toBe(false);
    await userEvent.click(chip);
    expect(lastQuery().textFiles).toBe(true);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
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
    // Opening searches at once, so Show more is there before the typed text's
    // debounced search, which would replace the page loaded here (CI).
    await waitFor(() => expect(lastQuery().text).toBe('p'));
    await waitFor(() => expect(useSearchStore.getState().stale()).toBe(false));
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(lastQuery().offset).toBe(1);
    // Queried inside waitFor: the list re-renders as the page arrives, and an
    // element found before that is detached by the time it's checked (CI).
    await waitFor(() => expect(screen.getByRole('option', { name: /More/ })).toBeInTheDocument());
    // The button can go a render after the page shows (seen on CI).
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull());
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
    // ⌘F too (M5b §7.3): Search where no editor shows (find in page routes it).
    expect(key({ metaKey: true, key: 'f', code: 'KeyF' })).toBe(true);
    expect(key({ ctrlKey: true, key: 'f', code: 'KeyF' })).toBe(true);
    expect(key({ metaKey: true, key: 'g', code: 'KeyG' })).toBe(false);
    expect(key({ metaKey: true, shiftKey: true, altKey: true, key: 'f', code: 'KeyF' })).toBe(
      false,
    );
    // Dvorak: the key that types F sits elsewhere; its letter wins.
    expect(key({ metaKey: true, shiftKey: true, key: 'u', code: 'KeyF' })).toBe(false);

    render(<Shortcuts />);
    fireEvent.keyDown(document.body, { metaKey: true, shiftKey: true, key: 'F', code: 'KeyF' });
    expect(useUiStore.getState().dialog).toEqual({ type: 'search' });
  });

  it('final review M12: on macOS only ⌘ counts (Ctrl+F stays forward-a-character)', () => {
    const key = (init: KeyboardEventInit, mac: boolean) =>
      isSearchKey(new KeyboardEvent('keydown', init), mac);
    expect(key({ ctrlKey: true, key: 'f', code: 'KeyF' }, true)).toBe(false);
    expect(key({ metaKey: true, key: 'f', code: 'KeyF' }, true)).toBe(true);
    expect(key({ ctrlKey: true, key: 'f', code: 'KeyF' }, false)).toBe(true);
  });

  it('final review M12: elsewhere Ctrl+F never reaches the webview’s find bar', () => {
    const stop = installNoFindBar(false);
    const e = new KeyboardEvent('keydown', { ctrlKey: true, key: 'f', cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    stop();
    const mac = installNoFindBar(true);
    const c = new KeyboardEvent('keydown', { ctrlKey: true, key: 'f', cancelable: true });
    window.dispatchEvent(c);
    expect(c.defaultPrevented).toBe(false);
    mac();
  });

  it('⌘⇧F in the editor opens Search with a short one-line selection as its text (M5b §7.3)', () => {
    useVaultStore.setState({ status: 'open' });
    render(
      <>
        <Shortcuts />
        <div className="cm-content" contentEditable suppressContentEditableWarning>
          The red wyrm sleeps
        </div>
      </>,
    );
    const content = document.querySelector<HTMLElement>('.cm-content')!;
    const select = (from: number, to: number) => {
      const range = document.createRange();
      range.setStart(content.firstChild!, from);
      range.setEnd(content.firstChild!, to);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
    };
    content.focus();
    select(8, 12);
    // ⌘F finds in the page (find in page): Search is ⌘⇧F there.
    fireEvent.keyDown(content, { metaKey: true, shiftKey: true, key: 'f', code: 'KeyF' });
    expect(useUiStore.getState().dialog).toEqual({ type: 'search' });
    expect(useSearchStore.getState().text).toBe('wyrm');
  });

  it('a second open while Search shows (menu and page both answering ⌘F) keeps it as it is', () => {
    useVaultStore.setState({ status: 'open' });
    openSearch();
    useSearchStore.getState().setText('typed');
    openSearch();
    expect(useSearchStore.getState().text).toBe('typed');
    expect(useUiStore.getState().dialog).toEqual({ type: 'search' });
    // Nor does it replace another dialog (the menu's ⌘F over Settings).
    useUiStore.getState().openDialog({ type: 'settings' });
    openSearch();
    expect(useUiStore.getState().dialog).toEqual({ type: 'settings' });
  });

  it('the floating button has Search with its shortcut (M5b §2.2)', async () => {
    render(<ActionButton />);
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const button = screen.getByRole('button', { name: 'Search' });
    // ⌘F finds in the page while the editor shows one; ⌘⇧F is always Search.
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Meta+Shift+F Control+Shift+F');
    await userEvent.click(button);
    expect(useUiStore.getState().dialog).toEqual({ type: 'search' });
  });
});
