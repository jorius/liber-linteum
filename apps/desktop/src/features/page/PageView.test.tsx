import { EditorView } from '@codemirror/view';
import { act, render, screen, waitFor } from '@testing-library/react';
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
import { LARGE_NOTE_CHARS } from '../editor/livePreview';
import { openPage } from '../../stores/navigate';
import { PageView } from './PageView';

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
    render(<PageView />);
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
    render(<PageView />);
    await open('Character Design/rex.md');
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent(
      'VaultCharacter Designrex',
    );
    // M2b §2: the title is the file name; the note's own title is shown under it.
    expect(screen.getByRole('heading', { level: 1, name: 'rex' })).toBeInTheDocument();
    expect(screen.getByText('Title in the note: Generator Rex')).toBeInTheDocument();
    expect(screen.getByText('Hero redesign · v3')).toBeInTheDocument();
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
    render(<PageView />);
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
    render(<PageView />);
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
    render(<PageView />);
    await open('A.md');
    const toggle = screen.getByRole('button', { name: 'Formatting toolbar' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(disk.calls).toContainEqual(['settings_set', { patch: { toolbar: false } }]);
    await waitFor(() => expect(screen.queryByRole('toolbar')).not.toBeInTheDocument());
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('save status: Saved → Saving… → Saved; failures say "Unsaved — retrying"', async () => {
    const disk = fakeDisk({ 'A.md': '# A\n' });
    render(<PageView />);
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

  it('the header follows an own save (title from the new text)', async () => {
    fakeDisk({ 'A.md': '# Old\n' });
    render(<PageView />);
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
    render(<PageView />);
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

  it('C2: the orphan banner shows whenever the page is orphaned, even while it is loaded', async () => {
    fakeDisk({ 'A.md': '# A\n' });
    render(<PageView />);
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
    render(<PageView />);
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
    render(<PageView />);
    await open('big.md');
    expect(screen.getByText('Simplified preview for large notes')).toBeInTheDocument();
  }, 30_000);

  it('NFR-10 has no axe violations', async () => {
    fakeDisk({ 'A.md': '# A\n\n- [x] done\n\n[[B]]\n' });
    const { container } = render(<PageView />);
    await open('A.md');
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
