import { EditorView } from '@codemirror/view';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { resetEditorStore, useEditorStore } from '../../stores/editorStore';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { fakeDisk } from '../../test/fakeDisk';
import { AUTOSAVE_MS } from '../editor/pageDoc';
import { COUNT_DEBOUNCE_MS } from './WordCount';
import { LARGE_NOTE_CHARS } from '../editor/livePreview';
import { openPage } from '../../stores/navigate';
import { PageScreen } from '../../test/pageScreen';

const open = (path: string) => act(() => usePageStore.getState().load(path));
const view = () => EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
const type = (text: string, at = 0) =>
  act(() => view().dispatch({ changes: { from: at, insert: text }, userEvent: 'input.type' }));

beforeEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useVaultStore.setState({ info: { name: 'Vault', root: '/v', report: {} as never } });
});
afterEach(async () => {
  usePageStore.getState().clear();
  resetEditorStore();
  await resetVaultStore();
  vi.useRealTimers();
  clearMocks();
});

describe('PageView (M2a §5)', () => {
  it('shows the empty state when nothing is selected', () => {
    render(<PageScreen />);
    expect(screen.getByText('Pick a page in the explorer')).toBeInTheDocument();
  });

  it('header: breadcrumb, title, subtitle, tags, counts and the cover (read-only)', async () => {
    fakeDisk(
      { 'Character Design/rex.md': '# Generator Rex\n\nBody\n' },
      {
        page_get: () => ({
          path: 'Character Design/rex.md',
          title: 'Generator Rex',
          subtitle: 'Hero redesign · v3',
          cover: 'assets/rex-cover.png',
          tags: ['character', 'redesign'],
          links: 8,
          backlinks: 1,
          text: '',
          truncated: false,
          binary: false,
        }),
        links_resolve: () => ['Character Design/assets/rex-cover.png'],
      },
    );
    render(<PageScreen />);
    await open('Character Design/rex.md');
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent(
      'VaultCharacter Designrex',
    );
    // M2b §2: the title is the file name; the note's own title is shown under it.
    expect(screen.getByRole('heading', { level: 1, name: 'rex' })).toBeInTheDocument();
    expect(screen.getByText('Title in the note: Generator Rex')).toBeInTheDocument();
    // M2c §3: the subtitle is editable in place.
    expect(screen.getByRole('textbox', { name: 'Subtitle' })).toHaveValue('Hero redesign · v3');
    expect(screen.getByRole('list', { name: 'Tags' })).toHaveTextContent('#character#redesign');
    expect(screen.getByText('8 links · 1 backlink')).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector('img[data-cover]')).toHaveAttribute(
        'src',
        'nimw-asset://localhost/Character%20Design/assets/rex-cover.png',
      ),
    );
  });

  it('edits the page; the mode toggle switches modes and remembers the choice', async () => {
    const disk = fakeDisk({ 'A.md': '# A\n\nbody\n' });
    render(<PageScreen />);
    await open('A.md');
    expect(view().state.doc.toString()).toBe('# A\n\nbody\n');
    expect(screen.getByRole('radio', { name: 'Live Preview' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Source' }));
    expect(disk.calls).toContainEqual(['settings_set', { patch: { editorMode: 'source' } }]);
    expect(view().dom).toHaveClass('cm-nimw-source');
    await userEvent.click(screen.getByRole('radio', { name: 'Split' }));
    expect(screen.getByRole('region', { name: 'Preview' })).toHaveTextContent('body');
  });

  it('M2b §3: the back arrow appears after following a link and goes back', async () => {
    fakeDisk({ 'A.md': '# A\n\n[[B]]\n', 'B.md': '# B\n' });
    render(<PageScreen />);
    await open('A.md');
    expect(screen.queryByRole('button', { name: /^Back to/ })).not.toBeInTheDocument();
    await act(() => openPage('B.md', null, 'link'));
    const back = await screen.findByRole('button', { name: 'Back to A' });
    await userEvent.click(back);
    await waitFor(() => expect(usePageStore.getState().path).toBe('A.md'));
    expect(screen.queryByRole('button', { name: /^Back to/ })).not.toBeInTheDocument();
  });

  it('M2b §6: the header button shows and hides the formatting toolbar', async () => {
    const disk = fakeDisk({ 'A.md': '# A\n\nbody\n' });
    render(<PageScreen />);
    await open('A.md');
    const toggle = screen.getByRole('button', { name: 'Formatting toolbar' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    // Feedback round: a labelled button whose tooltip says what a click does.
    expect(toggle).toHaveTextContent('Format');
    expect(toggle).toHaveAttribute('title', 'Hide the formatting toolbar');
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(disk.calls).toContainEqual(['settings_set', { patch: { toolbar: false } }]);
    await waitFor(() => expect(screen.queryByRole('toolbar')).not.toBeInTheDocument());
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveAttribute('title', 'Show the formatting toolbar');
  });

  it('M4b part 2 §5: the Outline button shows the outline beside the editor', async () => {
    const disk = fakeDisk({ 'A.md': '# A\n\n## B\n' });
    render(<PageScreen />);
    await open('A.md');
    const toggle = screen.getByRole('button', { name: 'Outline' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveAttribute('title', 'Show the outline');
    expect(screen.queryByRole('tree', { name: 'Outline' })).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(disk.calls).toContainEqual(['settings_set', { patch: { outline: true } }]);
    const tree = await screen.findByRole('tree', { name: 'Outline' });
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(2);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('M4b part 2 §5: the word count follows typing and the selection', async () => {
    const src = '---\ntags: [x]\n---\n# Title\n\nOne **two** [three](https://x.y/z).\n';
    fakeDisk({ 'A.md': src });
    render(<PageScreen />);
    await open('A.md');
    const count = screen.getByText('4 words · 1 min');
    expect(count).toHaveAttribute('title', '20 characters · 17 without spaces');
    vi.useFakeTimers();
    await type(' four five', src.length - 1);
    expect(count).toHaveTextContent('4 words');
    await act(() => vi.advanceTimersByTimeAsync(COUNT_DEBOUNCE_MS));
    expect(count).toHaveTextContent('6 words · 1 min');
    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
    const text = view.state.doc.toString();
    act(() =>
      view.dispatch({ selection: { anchor: text.indexOf('One'), head: text.indexOf(' **two') } }),
    );
    expect(count).toHaveTextContent('1 of 6 words');
  });

  it('M4b part 2 §5: another page shows its own count (CJK characters are words)', async () => {
    fakeDisk({ 'A.md': 'one two\n', 'B.md': '日本語 three\n' });
    render(<PageScreen />);
    await open('A.md');
    expect(screen.getByText('2 words · 1 min')).toBeInTheDocument();
    await act(() => openPage('B.md', null, 'link'));
    expect(await screen.findByText('4 words · 1 min')).toBeInTheDocument();
  });

  describe('the page width menu (M4b part 2 §1; part 3 wide elements §2)', () => {
    let widths: Record<string, string>;
    const setUp = async () => {
      widths = {};
      const settings = () => ({
        attachments: { mode: 'subfolder', path: 'attachments' },
        obsidian: null,
        overrideObsidian: false,
        pageWidth: null,
        pageWidths: widths,
      });
      fakeDisk(
        { 'A.md': '# A\n\nbody\n' },
        {
          vault_settings_get: settings,
          page_width_set: (args) => {
            const { path, width } = args as unknown as { path: string; width: string | null };
            widths = width ? { ...widths, [path]: width } : {};
            return settings();
          },
        },
      );
      render(<PageScreen />);
      await open('A.md');
    };
    const host = () => document.querySelector('.cm-editor')!.parentElement!;
    const button = () => screen.getByRole('button', { name: 'Page width' });

    it('offers Readable, Wide elements and Full width; the choice is kept for the page', async () => {
      await setUp();
      expect(button()).toHaveAttribute('aria-haspopup', 'menu');
      expect(button()).toHaveAttribute('aria-expanded', 'false');
      expect(button()).toHaveAttribute('title', 'Page width: Readable');
      expect(host().dataset.width).toBe('readable');
      await userEvent.click(button());
      const menu = screen.getByRole('menu', { name: 'Page width' });
      expect(button()).toHaveAttribute('aria-expanded', 'true');
      const items = within(menu).getAllByRole('menuitemradio');
      expect(items.map((i) => i.textContent)).toEqual(['Readable', 'Wide elements', 'Full width']);
      expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
      // Nothing of its own yet: Reset is there but unavailable.
      expect(within(menu).getByRole('menuitem', { name: 'Reset to default' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await userEvent.click(items[1]);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      await waitFor(() => expect(host().dataset.width).toBe('wide'));
      expect(widths).toEqual({ 'A.md': 'wide' });
      expect(button()).toHaveAttribute('title', 'Page width: Wide elements');
      expect(button()).toHaveFocus();
      await userEvent.click(button());
      await userEvent.click(screen.getByRole('menuitemradio', { name: 'Full width' }));
      await waitFor(() => expect(host().dataset.width).toBe('full'));
      expect(widths).toEqual({ 'A.md': 'full' });
      // Reset clears the page's own width.
      await userEvent.click(button());
      await userEvent.click(screen.getByRole('menuitem', { name: 'Reset to default' }));
      await waitFor(() => expect(host().dataset.width).toBe('readable'));
      expect(widths).toEqual({});
    });

    it('works from the keyboard: arrows move, Enter chooses, Escape closes', async () => {
      await setUp();
      button().focus();
      await userEvent.keyboard('{Enter}');
      const checked = screen.getByRole('menuitemradio', { name: 'Readable' });
      expect(checked).toHaveFocus();
      await userEvent.keyboard('{ArrowDown}');
      expect(screen.getByRole('menuitemradio', { name: 'Wide elements' })).toHaveFocus();
      await userEvent.keyboard('{End}');
      // Reset is skipped while unavailable: End lands on the last radio.
      expect(screen.getByRole('menuitemradio', { name: 'Full width' })).toHaveFocus();
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(button()).toHaveFocus();
      await userEvent.keyboard('{Enter}');
      await userEvent.keyboard('{ArrowDown}{Enter}');
      await waitFor(() => expect(widths).toEqual({ 'A.md': 'wide' }));
      expect(button()).toHaveFocus();
    });

    it('has no axe violations with the menu open', async () => {
      await setUp();
      await userEvent.click(button());
      const res = await axe.run(document.body, { resultTypes: ['violations'] });
      expect(res.violations.map((v) => v.id)).toEqual([]);
    });
  });

  it('save status: Saved → Saving… → Saved; failures say "Unsaved — retrying"', async () => {
    const disk = fakeDisk({ 'A.md': '# A\n' });
    render(<PageScreen />);
    await open('A.md');
    vi.useFakeTimers();
    const status = screen.getByRole('status', { name: 'Save status' });
    expect(status).toHaveTextContent('Saved');
    await type('x');
    expect(status).toHaveTextContent('Saving…');
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_MS));
    expect(status).toHaveTextContent('Saved');
    disk.failWrites(1);
    await type('y');
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_MS));
    expect(status).toHaveTextContent('Unsaved — retrying');
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(status).toHaveTextContent('Saved');
  });

  it('M5b §6: Saved is green, Unsaved red; with auto save off nothing is written until ⌘S', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, autoSave: false } });
    const disk = fakeDisk({ 'A.md': '# A\n' });
    render(<PageScreen />);
    await open('A.md');
    vi.useFakeTimers();
    const status = screen.getByRole('status', { name: 'Save status' });
    expect(status).toHaveAttribute('data-status', 'saved');
    await type('x');
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(status).toHaveTextContent('Unsaved');
    expect(status).toHaveAttribute('data-status', 'unsaved');
    expect(disk.writes()).toEqual([]);
    await act(() => useEditorStore.getState().doc!.flush());
    expect(status).toHaveTextContent('Saved');
    expect(disk.writes()).toHaveLength(1);
  });

  it('the header follows an own save (title from the new text)', async () => {
    fakeDisk({ 'A.md': '# Old\n' });
    render(<PageScreen />);
    await open('A.md');
    expect(screen.getByText('Title in the note: Old')).toBeInTheDocument();
    await act(async () => {
      view().dispatch({ changes: { from: 2, to: 5, insert: 'New' } });
      await useEditorStore.getState().flushAll();
    });
    await waitFor(() => expect(screen.getByText('Title in the note: New')).toBeInTheDocument());
  });

  it('deleted outside while dirty: the text stays and can be saved as a new page', async () => {
    const disk = fakeDisk({ 'notes/A.md': '# A\n' });
    render(<PageScreen />);
    await open('notes/A.md');
    await type('kept ', 4);
    disk.files.delete('notes/A.md');
    await act(() =>
      usePageStore
        .getState()
        .onExternalChange({ created: [], modified: [], removed: ['notes/A.md'], renamed: [] }),
    );
    expect(
      screen.getByText('This page was deleted outside the app. Your text is still here.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save as new page' }));
    await waitFor(() => expect(disk.files.get('notes/A.md')).toBe('# A\nkept '));
    await waitFor(() => expect(usePageStore.getState().state).toBe('ready'));
  });

  it('final review I3: rewritten outside as non-UTF-8 while edited, the text stays with a notice and Save as new page', async () => {
    const disk = fakeDisk({ 'A.md': '# Café\n' });
    render(<PageScreen />);
    await open('A.md');
    await type('kept ', 7);
    disk.files.set('A.md', '# Caf\0\n'); // a NUL stands for bytes that aren't UTF-8
    await act(() =>
      usePageStore
        .getState()
        .onExternalChange({ created: [], modified: ['A.md'], removed: [], renamed: [] }),
    );
    expect(
      screen.getByText(
        'This page changed outside Notes In My Way and is no longer text it can edit. ' +
          'Your unsaved changes are kept here: copy them, or save them as a new page.',
      ),
    ).toBeInTheDocument();
    expect(view().state.doc.toString()).toBe('# Café\nkept ');
    await userEvent.click(screen.getByRole('button', { name: 'Save as new page' }));
    await waitFor(() => expect([...disk.files.values()]).toContain('# Café\nkept '));
    expect(disk.files.get('A.md')).toBe('# Caf\0\n');
  });

  it('C2: the orphan banner shows whenever the page is orphaned, even while it is loaded', async () => {
    fakeDisk({ 'A.md': '# A\n' });
    render(<PageScreen />);
    await open('A.md');
    await type('kept ', 4);
    expect(usePageStore.getState().state).toBe('ready');
    act(() => void useEditorStore.getState().doc!.markDeleted());
    expect(
      screen.getByText('This page was deleted outside the app. Your text is still here.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save as new page' })).toBeInTheDocument();
  });

  it('binary pages and the loading state', async () => {
    mockIPC((cmd) => {
      if (cmd === 'page_get')
        return { path: 'x.md', title: 'x', tags: [], links: 0, backlinks: 0, binary: true };
      throw { kind: 'binary', message: 'not UTF-8 text: x.md' };
    });
    render(<PageScreen />);
    act(() => usePageStore.setState({ path: 'x.md', state: 'loading' }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    await open('x.md');
    expect(
      screen.getByText("This file isn't valid UTF-8 text, so it can't be shown."),
    ).toBeInTheDocument();
    expect(document.querySelector('.cm-editor')).toBeNull();
  });

  // Parses a real 200 KB note: seconds when the whole suite runs in parallel.
  it('large notes say the preview is simplified', async () => {
    const para = 'a short paragraph of text\n\n';
    fakeDisk({
      'big.md': `# Big\n\n${para.repeat(Math.ceil(LARGE_NOTE_CHARS / para.length) + 10)}`,
    });
    render(<PageScreen />);
    await open('big.md');
    expect(screen.getByText('Simplified preview for large notes')).toBeInTheDocument();
  }, 30_000);

  it('NFR-10 has no axe violations', async () => {
    fakeDisk({ 'A.md': '# A\n\n- [x] done\n\n[[B]]\n' });
    const { container } = render(<PageScreen />);
    await open('A.md');
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
