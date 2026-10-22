import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Home, TreeNode, VaultInfo } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { openPage } from '../../stores/navigate';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { useTrailStore } from '../../stores/trailStore';
import { childrenByParent } from '../../stores/tree';
import { useUiStore } from '../../stores/uiStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { VaultSettingsSection } from '../dialogs/VaultSettingsSection';
import { ContextMenu } from '../explorer/ContextMenu';
import { Toolbar } from '../global-view/Toolbar';
import { useGvStore } from '../global-view/gvStore';
import { AppShell } from '../shell/AppShell';
import { openInVault } from '../singleFile/openFile';
import { HomeToggle } from './HomeToggle';
import { useHomeStore } from './homeStore';

const nodes: TreeNode[] = [
  { path: 'Lore', kind: 'folder' },
  { path: 'Lore/Lore.md', kind: 'page' },
  { path: 'Lore/Dragons.md', kind: 'page' },
  { path: 'Lore/map.png', kind: 'attachment' },
  { path: 'Lore/notes.txt', kind: 'attachment' },
  { path: 'Welcome.md', kind: 'page' },
  { path: 'Start.md', kind: 'page' },
];

const report = { files: 1, pages: 1, parsed: 1, skippedUnchanged: 0, removed: 0, warnings: [] };
const info = (extra: Partial<VaultInfo> = {}): VaultInfo => ({
  name: 'Vault',
  root: '/v',
  report: { ...report, durationMs: 1 },
  ...extra,
});

type Handler = (a: Record<string, unknown>) => unknown;

/** A fake backend: the home kept here, as Rust keeps it in vault.json. */
function backend(handlers: Record<string, Handler> = {}, start: Home | null = null) {
  let home: Home | null = start;
  const calls: [string, Record<string, unknown>][] = [];
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push([cmd, a]);
    if (handlers[cmd]) return handlers[cmd](a);
    switch (cmd) {
      case 'home_get':
        return home;
      case 'home_set':
        home = (a.home as Home | null) ?? null;
        return home;
      case 'vault_tree':
        return nodes;
      case 'page_get':
        return {
          path: a.path,
          title: String(a.path),
          subtitle: null,
          cover: null,
          tags: [],
          links: 0,
          backlinks: 0,
        };
      case 'page_read':
        return { text: '# x', hash: 'h' };
      default:
        return undefined;
    }
  });
  return {
    calls,
    sets: () => calls.filter(([c]) => c === 'home_set').map(([, a]) => a.home),
    stored: () => home,
  };
}

function seed(extra: Partial<VaultInfo> = {}) {
  act(() =>
    useVaultStore.setState({
      status: 'open',
      info: info(extra),
      nodes,
      children: childrenByParent(nodes),
      expanded: new Set(['Lore']),
      selected: null,
    }),
  );
}

const axeRun = (el: Element) =>
  axe.run(el, { rules: { 'color-contrast': { enabled: false } } }).then((r) => r.violations);

const items = () =>
  within(screen.getByRole('menu'))
    .getAllByRole('menuitem')
    .map((i) => i.textContent);

beforeEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useUiStore.setState({ screen: 'edit' });
  useHomeStore.setState({ home: null });
});

afterEach(async () => {
  await resetVaultStore();
  usePageStore.getState().clear();
  useTrailStore.getState().reset();
  useUiStore.getState().closeDialog();
  useToastStore.getState().clear();
  useGvStore.getState().reset();
  useHomeStore.setState({ home: null });
  clearMocks();
});

describe('the tree’s context menu', () => {
  const menu = (path: string) =>
    render(<ContextMenu menu={{ path, anchor: { x: 10, y: 10 } }} onClose={() => undefined} />);

  it('offers "Set as home page" on a page and saves it', async () => {
    const be = backend();
    seed();
    menu('Welcome.md');
    expect(items()).toContain('Set as home page');
    expect(items()).not.toContain('Remove as home page');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Set as home page' }));
    await waitFor(() => expect(be.sets()).toEqual([{ kind: 'page', path: 'Welcome.md' }]));
    expect(useHomeStore.getState().home).toEqual({ kind: 'page', path: 'Welcome.md' });
  });

  it('offers "Remove as home page" on the home page, which clears it', async () => {
    const be = backend({}, { kind: 'page', path: 'Welcome.md' });
    seed();
    useHomeStore.setState({ home: { kind: 'page', path: 'Welcome.md' } });
    menu('Welcome.md');
    expect(items()).toContain('Remove as home page');
    expect(items()).not.toContain('Set as home page');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove as home page' }));
    await waitFor(() => expect(be.sets()).toEqual([null]));
    expect(useHomeStore.getState().home).toBeNull();
  });

  it('a folder acts on its own page; text files count, images and plain folders don’t', async () => {
    const be = backend();
    seed();
    const { unmount } = menu('Lore');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Set as home page' }));
    await waitFor(() => expect(be.sets()).toEqual([{ kind: 'page', path: 'Lore/Lore.md' }]));
    unmount();
    const text = menu('Lore/notes.txt');
    expect(items()).toContain('Set as home page');
    text.unmount();
    menu('Lore/map.png');
    expect(items()).not.toContain('Set as home page');
  });

  it('isn’t offered in the global Scratchpad', () => {
    backend();
    seed({ scratchpad: true });
    menu('Welcome.md');
    expect(items()).not.toContain('Set as home page');
  });
});

describe('the house in the tree', () => {
  it('marks the home page quietly, named "Home page", and moves when the home does', async () => {
    backend({}, { kind: 'page', path: 'Lore/Dragons.md' });
    seed();
    act(() => useHomeStore.setState({ home: { kind: 'page', path: 'Lore/Dragons.md' } }));
    render(<AppShell />);
    const row = screen.getByRole('treeitem', { name: 'Dragons' });
    expect(row).toHaveAccessibleDescription('Home page');
    const glyph = within(row).getByRole('img', { name: 'Home page' });
    expect(glyph).toHaveAttribute('title', 'Home page');
    expect(screen.getAllByRole('img', { name: 'Home page' })).toHaveLength(1);
    expect(screen.getByRole('treeitem', { name: 'Welcome' })).not.toHaveAccessibleDescription();
    act(() => useHomeStore.setState({ home: { kind: 'globalView' } }));
    expect(screen.queryByRole('img', { name: 'Home page' })).toBeNull();
    expect(await axeRun(document.body)).toEqual([]);
  });
});

describe('the page header', () => {
  it('has a house toggle that sets and removes the page as home', async () => {
    const be = backend();
    seed();
    render(<HomeToggle path="Start.md" />);
    const on = screen.getByRole('button', { name: 'Set as home page' });
    expect(on).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(on);
    const off = await screen.findByRole('button', { name: 'Remove as home page' });
    expect(off).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(off);
    await waitFor(() => expect(be.sets()).toEqual([{ kind: 'page', path: 'Start.md' }, null]));
  });
});

describe('the Global View', () => {
  it('has an obvious "Use as home" toggle in its toolbar', async () => {
    const be = backend();
    seed();
    render(<Toolbar />);
    const toggle = screen.getByRole('button', { name: 'Use as home' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveAttribute('title', 'Open this vault on the Global View');
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'true'));
    expect(be.sets()).toEqual([{ kind: 'globalView' }]);
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'false'));
    expect(be.sets()).toEqual([{ kind: 'globalView' }, null]);
    // Rendered on its own: no landmark around it here.
    const found = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(found.violations).toEqual([]);
  });

  it('a page home is not the Global View’s', () => {
    backend();
    seed();
    useHomeStore.setState({ home: { kind: 'page', path: 'Start.md' } });
    render(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Use as home' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});

describe('Settings → This vault → Home', () => {
  const suggest = () =>
    ['Start.md', 'Welcome.md', '.archive/Old.md'].map((path) => ({
      path,
      kind: 'page',
      title: path.replace(/\.md$/, '').replace(/^.*\//, ''),
      target: path,
    }));

  it('chooses nothing, the Global View or a page from the picker', async () => {
    const be = backend({ vault_settings_get: () => null, link_suggest: suggest });
    seed();
    render(<VaultSettingsSection />);
    const home = screen.getByRole('combobox', { name: 'Home' });
    expect(home).toHaveValue('none');
    expect(home).toHaveAccessibleDescription('What shows when this vault opens.');
    expect(
      within(home)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Nothing (pick a page)', 'Global View', 'A page…']);
    await userEvent.selectOptions(home, 'globalView');
    await waitFor(() => expect(be.sets()).toEqual([{ kind: 'globalView' }]));
    // A page…: the page picker opens; archived pages aren't offered.
    await userEvent.selectOptions(home, 'page');
    const find = await screen.findByRole('combobox', { name: 'Find the home page' });
    await waitFor(() =>
      expect(
        within(screen.getByRole('listbox'))
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['StartStart.md', 'WelcomeWelcome.md']),
    );
    await userEvent.type(find, 'Wel');
    await userEvent.click(await screen.findByRole('option', { name: /Welcome/ }));
    await waitFor(() =>
      expect(be.sets()).toEqual([{ kind: 'globalView' }, { kind: 'page', path: 'Welcome.md' }]),
    );
    expect(home).toHaveValue('page');
    expect(screen.getByText('Welcome', { selector: '[data-home-page]' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change…' })).toBeInTheDocument();
    await userEvent.selectOptions(home, 'none');
    await waitFor(() => expect(be.stored()).toBeNull());
    expect(screen.queryByRole('button', { name: 'Change…' })).toBeNull();
    expect(await axeRun(document.body)).toEqual([]);
  });

  it('A page… closed without picking goes back to what is stored', async () => {
    const be = backend(
      { vault_settings_get: () => null, link_suggest: suggest },
      { kind: 'globalView' },
    );
    seed();
    useHomeStore.setState({ home: { kind: 'globalView' } });
    render(<VaultSettingsSection />);
    const home = screen.getByRole('combobox', { name: 'Home' });
    expect(home).toHaveValue('globalView');
    await userEvent.selectOptions(home, 'page');
    expect(screen.getByText('No page chosen yet')).toBeInTheDocument();
    const find = await screen.findByRole('combobox', { name: 'Find the home page' });
    await userEvent.type(find, '{Escape}');
    await waitFor(() => expect(home).toHaveValue('globalView'));
    expect(be.sets()).toEqual([]);
  });

  it('isn’t shown for the global Scratchpad', () => {
    backend({ vault_settings_get: () => null });
    seed({ scratchpad: true });
    render(<VaultSettingsSection />);
    expect(screen.queryByRole('combobox', { name: 'Home' })).toBeNull();
  });
});

describe('opening a vault goes home', () => {
  const page = (path: string): Home => ({ kind: 'page', path });

  it('opens the home page, first on the link trail, with the window named after it', async () => {
    backend({ vault_open: () => info({ home: page('Lore/Dragons.md') }) });
    useTrailStore.setState({ back: [{ path: 'old.md', heading: null }], forward: [] });
    await act(() => useVaultStore.getState().open('/v'));
    expect(usePageStore.getState().path).toBe('Lore/Dragons.md');
    expect(useUiStore.getState().screen).toBe('edit');
    expect(useVaultStore.getState().selected).toBe('Lore/Dragons.md');
    expect(useTrailStore.getState().back).toEqual([]);
    expect(useHomeStore.getState().home).toEqual(page('Lore/Dragons.md'));
    // A link from it: Back comes home.
    await act(() => openPage('Welcome.md', null, 'link'));
    expect(useTrailStore.getState().back).toEqual([{ path: 'Lore/Dragons.md', heading: null }]);
  });

  it('shows the Global View when it is the home', async () => {
    backend({ vault_open: () => info({ home: { kind: 'globalView' } }) });
    await act(() => useVaultStore.getState().open('/v'));
    expect(useUiStore.getState().screen).toBe('global');
    expect(usePageStore.getState().path).toBeNull();
  });

  it('with no home, nothing changes: the editor asks for a page', async () => {
    const be = backend({ vault_open: () => info() });
    await act(() => useVaultStore.getState().open('/v'));
    expect(useUiStore.getState().screen).toBe('edit');
    expect(usePageStore.getState().path).toBeNull();
    expect(be.calls.some(([c]) => c === 'page_get')).toBe(false);
  });

  it('a home page that is gone leaves the editor asking for one', async () => {
    backend({ vault_open: () => info({ home: page('Gone.md') }) });
    await act(() => useVaultStore.getState().open('/v'));
    expect(usePageStore.getState().path).toBeNull();
  });

  it('closing and reopening goes home again; another vault goes to its own home', async () => {
    let next = info({ home: page('Start.md') });
    backend({ vault_open: () => next, vault_close: () => null });
    await act(() => useVaultStore.getState().open('/v'));
    await act(() => openPage('Welcome.md'));
    await act(() => useVaultStore.getState().close());
    expect(useHomeStore.getState().home).toBeNull();
    await act(() => useVaultStore.getState().open('/v'));
    expect(usePageStore.getState().path).toBe('Start.md');
    // Switching vaults: the other one's home (here, the Global View).
    next = info({ root: '/w', name: 'W', home: { kind: 'globalView' } });
    await act(() => useVaultStore.getState().open('/w'));
    expect(useUiStore.getState().screen).toBe('global');
    expect(usePageStore.getState().path).toBeNull();
    // And back: its page again.
    next = info({ home: page('Start.md') });
    await act(() => useVaultStore.getState().open('/v'));
    expect(useUiStore.getState().screen).toBe('edit');
    expect(usePageStore.getState().path).toBe('Start.md');
  });

  it('after unlocking an encrypted vault', async () => {
    backend({
      vault_open: () => {
        throw { kind: 'locked', message: 'locked' };
      },
      vault_unlock: () => info({ root: '/enc', encrypted: true, home: page('Welcome.md') }),
    });
    await act(() => useVaultStore.getState().open('/enc'));
    expect(useVaultStore.getState().status).toBe('locked');
    expect(usePageStore.getState().path).toBeNull();
    await act(() => useVaultStore.getState().unlock({ kind: 'passphrase', value: 'x' }));
    expect(usePageStore.getState().path).toBe('Welcome.md');
  });

  describe('an explicit request wins', () => {
    it('a file opened into the vault from outside', async () => {
      backend({ vault_open: () => info({ home: { kind: 'globalView' } }) });
      await act(() => openInVault('/v', 'Welcome.md'));
      expect(useUiStore.getState().screen).toBe('edit');
      expect(usePageStore.getState().path).toBe('Welcome.md');
      expect(useTrailStore.getState().back).toEqual([]);
    });

    it('a file opened from outside, over a page home: never shown first', async () => {
      const be = backend({ vault_open: () => info({ home: page('Start.md') }) });
      await act(() => openInVault('/v', 'Welcome.md'));
      expect(usePageStore.getState().path).toBe('Welcome.md');
      expect(be.calls.filter(([c]) => c === 'page_get').map(([, a]) => a.path)).toEqual([
        'Welcome.md',
      ]);
    });

    it('the vault alone from outside goes home', async () => {
      backend({ vault_open: () => info({ home: page('Start.md') }) });
      await act(() => openInVault('/v', null));
      expect(usePageStore.getState().path).toBe('Start.md');
    });

    it('a Notion import opens its report page, not the home', async () => {
      const be = backend({
        notion_import: () => ({
          vault: info({ root: '/n', home: { kind: 'globalView' } }),
          report: 'Notion import report.md',
          cancelled: false,
          failed: null,
          root: '/n',
        }),
      });
      await act(() => useVaultStore.getState().importNotion('Wiki'));
      expect(useUiStore.getState().screen).toBe('edit');
      expect(be.calls.some(([c]) => c === 'page_get')).toBe(false);
    });

    it('the vault a failed Notion import left', async () => {
      backend({ notion_open_partial: () => info({ home: page('Start.md') }) });
      await act(() => useVaultStore.getState().openPartialImport());
      expect(usePageStore.getState().path).toBeNull();
    });

    it('the global Scratchpad keeps opening to its quick notes', async () => {
      backend({
        scratchpad_open: () => info({ scratchpad: true, home: page('Start.md') }),
      });
      await act(() => useVaultStore.getState().openScratchpad());
      expect(usePageStore.getState().path).toBeNull();
      expect(useHomeStore.getState().home).toBeNull();
    });

    it('an open asked not to go home (a page from a link or toast follows)', async () => {
      backend({ vault_open: () => info({ home: page('Start.md') }) });
      await act(() => useVaultStore.getState().open('/v', { home: false }));
      expect(usePageStore.getState().path).toBeNull();
    });
  });
});
