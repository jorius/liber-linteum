import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { resetEditorStore } from '../../stores/editorStore';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { fakeDisk } from '../../test/fakeDisk';
import { PageView } from './PageView';

const open = (path: string) => act(() => usePageStore.getState().load(path));

/** Resolves path-style cover targets next to the page (enough for tests). */
const resolveCovers = (args: Record<string, unknown>) =>
  (args.targets as { kind: string; target: string }[]).map((t) => {
    if (t.kind !== 'cover') return null;
    if (t.target.startsWith('/')) return t.target.slice(1);
    const dir = (args.source as string).split('/').slice(0, -1).join('/');
    return t.target === 'gone.png' ? null : dir ? `${dir}/${t.target}` : t.target;
  });

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

describe('Cover (M2c §2)', () => {
  it('"Add cover" picks an image in Rust and writes cover: to the frontmatter', async () => {
    const disk = fakeDisk(
      { 'Chars/Rex.md': '# Rex\n' },
      {
        cover_pick: () => ({ path: 'Chars/attachments/sky.png', reference: 'attachments/sky.png' }),
        links_resolve: resolveCovers,
      },
    );
    render(<PageView />);
    await open('Chars/Rex.md');
    await userEvent.click(screen.getByRole('button', { name: 'Add cover' }));
    expect(disk.calls).toContainEqual(['cover_pick', { page: 'Chars/Rex.md' }]);
    await waitFor(() =>
      expect(disk.files.get('Chars/Rex.md')).toBe('---\ncover: attachments/sky.png\n---\n# Rex\n'),
    );
    await waitFor(() =>
      expect(document.querySelector('img[data-cover]')).toHaveAttribute(
        'src',
        'nimw-asset://localhost/Chars/attachments/sky.png',
      ),
    );
    expect(disk.calls.some(([c]) => c === 'vault_tree')).toBe(true);
  });

  it('cancelling the dialog changes nothing', async () => {
    const disk = fakeDisk({ 'Rex.md': '# Rex\n' }, { cover_pick: () => null });
    render(<PageView />);
    await open('Rex.md');
    await userEvent.click(screen.getByRole('button', { name: 'Add cover' }));
    await waitFor(() => expect(disk.calls.some(([c]) => c === 'cover_pick')).toBe(true));
    expect(disk.writes()).toEqual([]);
  });

  it('Remove deletes cover and cover-y but keeps the image file', async () => {
    const disk = fakeDisk(
      { 'Rex.md': '---\ncover: a.png\ncover-y: 30\nsubtitle: S\n---\n# Rex\n' },
      { links_resolve: resolveCovers },
    );
    render(<PageView />);
    await open('Rex.md');
    const band = await screen.findByRole('group', { name: 'Cover' });
    await userEvent.click(within(band).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(disk.files.get('Rex.md')).toBe('---\nsubtitle: S\n---\n# Rex\n'));
    expect(disk.calls.some(([c]) => c === 'entry_trash')).toBe(false);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add cover' })).toBeInTheDocument(),
    );
  });

  it('Reposition: arrows move 5%, Save writes cover-y, Escape restores', async () => {
    const disk = fakeDisk(
      { 'Rex.md': '---\ncover: a.png\ncover-y: 40\n---\n# Rex\n' },
      { links_resolve: resolveCovers },
    );
    render(<PageView />);
    await open('Rex.md');
    const img = await waitFor(() => document.querySelector<HTMLImageElement>('img[data-cover]')!);
    expect(img.style.objectPosition).toBe('50% 40%');
    await userEvent.click(screen.getByRole('button', { name: 'Reposition' }));
    const slider = screen.getByRole('slider', { name: 'Cover position' });
    expect(slider).toHaveFocus();
    expect(slider).toHaveAttribute('aria-valuenow', '40');
    await userEvent.keyboard('{ArrowUp}{ArrowUp}{ArrowDown}');
    expect(slider).toHaveAttribute('aria-valuenow', '45');
    expect(img.style.objectPosition).toBe('50% 45%');
    await userEvent.keyboard('{Escape}');
    expect(img.style.objectPosition).toBe('50% 40%');
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(disk.writes()).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Reposition' }));
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.click(screen.getByRole('button', { name: 'Save position' }));
    await waitFor(() =>
      expect(disk.files.get('Rex.md')).toBe('---\ncover: a.png\ncover-y: 35\n---\n# Rex\n'),
    );
  });

  it('remote and missing covers show a placeholder with Change and Remove', async () => {
    fakeDisk(
      {
        'Web.md': '---\ncover: https://example.com/x.png\n---\n',
        'Gone.md': '---\ncover: gone.png\n---\n',
      },
      { links_resolve: resolveCovers },
    );
    render(<PageView />);
    await open('Web.md');
    const web = await screen.findByRole('group', { name: 'Cover' });
    expect(web).toHaveTextContent('Remote cover not loaded (privacy)');
    expect(within(web).getByRole('button', { name: 'Change cover' })).toBeInTheDocument();
    expect(within(web).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(document.querySelector('img[data-cover]')).toBeNull();
    await open('Gone.md');
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'Cover' })).toHaveTextContent(
        'Cover image not found',
      ),
    );
  });

  it('read-only without an editable document (binary page)', async () => {
    fakeDisk(
      {},
      {
        page_get: () => ({
          path: 'x.md',
          title: 'x',
          subtitle: 'S',
          cover: 'a.png',
          coverY: null,
          tags: [],
          links: 0,
          backlinks: 0,
          text: '',
          truncated: false,
          binary: true,
        }),
        page_read: () => {
          throw { kind: 'binary', message: 'not UTF-8' };
        },
        links_resolve: () => ['a.png'],
      },
    );
    render(<PageView />);
    await open('x.md');
    await waitFor(() => expect(document.querySelector('img[data-cover]')).not.toBeNull());
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add cover' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Subtitle' })).not.toBeInTheDocument();
    expect(screen.getByText('S')).toBeInTheDocument();
  });

  describe('keyboard focus is never lost (final review I3)', () => {
    /** Answers after a real delay, so the "loading" band is committed in
     *  between, as with the real IPC. */
    const slowResolve = (args: Record<string, unknown>) =>
      new Promise((r) => setTimeout(() => r(resolveCovers(args)), 20));

    it('Remove moves focus to Add cover', async () => {
      fakeDisk({ 'Rex.md': '---\ncover: a.png\n---\n# Rex\n' }, { links_resolve: slowResolve });
      render(<PageView />);
      await open('Rex.md');
      const band = await screen.findByRole('group', { name: 'Cover' });
      await waitFor(() => expect(document.querySelector('img[data-cover]')).not.toBeNull());
      within(band).getByRole('button', { name: 'Remove' }).focus();
      await userEvent.keyboard('{Enter}');
      const add = await screen.findByRole('button', { name: 'Add cover' });
      await waitFor(() => expect(add).toHaveFocus());
    });

    it('Add cover moves focus to Change cover once the image shows', async () => {
      fakeDisk(
        { 'Rex.md': '# Rex\n' },
        {
          cover_pick: () => ({ path: 'sky.png', reference: 'sky.png' }),
          links_resolve: slowResolve,
        },
      );
      render(<PageView />);
      await open('Rex.md');
      screen.getByRole('button', { name: 'Add cover' }).focus();
      await userEvent.keyboard('{Enter}');
      await waitFor(() => expect(document.querySelector('img[data-cover]')).not.toBeNull());
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Change cover' })).toHaveFocus(),
      );
    });

    it('Change cover keeps focus on Change cover while the new image loads', async () => {
      fakeDisk(
        { 'Rex.md': '---\ncover: a.png\n---\n# Rex\n' },
        {
          cover_pick: () => ({ path: 'b.png', reference: 'b.png' }),
          links_resolve: slowResolve,
        },
      );
      render(<PageView />);
      await open('Rex.md');
      await waitFor(() => expect(document.querySelector('img[data-cover]')).not.toBeNull());
      screen.getByRole('button', { name: 'Change cover' }).focus();
      await userEvent.keyboard('{Enter}');
      await waitFor(() =>
        expect(document.querySelector('img[data-cover]')).toHaveAttribute(
          'src',
          'nimw-asset://localhost/b.png',
        ),
      );
      expect(screen.getByRole('button', { name: 'Change cover' })).toHaveFocus();
    });

    it('cancelling Add cover leaves focus on Add cover', async () => {
      const disk = fakeDisk({ 'Rex.md': '# Rex\n' }, { cover_pick: () => null });
      render(<PageView />);
      await open('Rex.md');
      const add = screen.getByRole('button', { name: 'Add cover' });
      add.focus();
      await userEvent.keyboard('{Enter}');
      await waitFor(() => expect(disk.calls.some(([c]) => c === 'cover_pick')).toBe(true));
      await waitFor(() => expect(add).toHaveFocus());
    });

    it('does not pull focus back if the user moved it elsewhere meanwhile', async () => {
      let answer!: (v: unknown) => void;
      fakeDisk(
        { 'Rex.md': '# Rex\n' },
        {
          cover_pick: () => new Promise((r) => (answer = r)),
          links_resolve: slowResolve,
        },
      );
      render(<PageView />);
      await open('Rex.md');
      screen.getByRole('button', { name: 'Add cover' }).focus();
      await userEvent.keyboard('{Enter}');
      const subtitle = screen.getByRole('textbox', { name: 'Subtitle' });
      act(() => subtitle.focus());
      await act(async () => answer({ path: 'sky.png', reference: 'sky.png' }));
      await waitFor(() => expect(document.querySelector('img[data-cover]')).not.toBeNull());
      expect(subtitle).toHaveFocus();
    });
  });

  it('has no axe violations with the cover controls', async () => {
    fakeDisk({ 'Rex.md': '---\ncover: a.png\n---\n# Rex\n' }, { links_resolve: resolveCovers });
    render(<PageView />);
    await open('Rex.md');
    await screen.findByRole('group', { name: 'Cover' });
    await userEvent.click(screen.getByRole('button', { name: 'Reposition' }));
    const header = document.querySelector('header')!;
    const violations = await axe
      .run(header, { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
  });
});

describe('Subtitle (M2c §3)', () => {
  it('Enter writes subtitle:, Escape restores, empty removes the key', async () => {
    const disk = fakeDisk({ 'Rex.md': '# Rex\n' });
    render(<PageView />);
    await open('Rex.md');
    const field = screen.getByRole('textbox', { name: 'Subtitle' });
    expect(field).toHaveAttribute('placeholder', 'Add a subtitle');
    await userEvent.type(field, 'Hero redesign{Enter}');
    await waitFor(() =>
      expect(disk.files.get('Rex.md')).toBe('---\nsubtitle: Hero redesign\n---\n# Rex\n'),
    );
    expect(field).toHaveFocus();
    await userEvent.type(field, ' v4{Escape}');
    expect(field).toHaveValue('Hero redesign');
    expect(field).toHaveFocus();
    await userEvent.clear(field);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(disk.files.get('Rex.md')).toBe('# Rex\n'));
  });

  it('switching apps mid-edit (window blur) does not save; a click elsewhere does', async () => {
    const disk = fakeDisk({ 'Rex.md': '# Rex\n' });
    render(<PageView />);
    await open('Rex.md');
    const field = screen.getByRole('textbox', { name: 'Subtitle' });
    await userEvent.type(field, 'Half');
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    act(() => field.blur());
    await new Promise((r) => setTimeout(r, 20));
    expect(disk.writes()).toEqual([]);
    hasFocus.mockReturnValue(true);
    await userEvent.click(field);
    await userEvent.click(document.body);
    await waitFor(() => expect(disk.files.get('Rex.md')).toBe('---\nsubtitle: Half\n---\n# Rex\n'));
  });
});
