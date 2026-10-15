import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GvCard, GvLevel, GvLevelRef } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { installReactFlowStubs } from '../../test/reactFlow';
import { GlobalView } from './GlobalView';
import { levelKey, useGvStore } from './gvStore';

beforeAll(installReactFlowStubs);

function card(path: string, kind: GvCard['kind'] = 'page', extra: Partial<GvCard> = {}): GvCard {
  return {
    path,
    kind,
    title: path.split('/').pop()!.replace(/\.md$/, ''),
    subtitle: null,
    cover: null,
    coverRemote: false,
    coverY: null,
    coverX: null,
    coverSide: 'top',
    excerpt: '',
    hasImage: false,
    hasAudio: false,
    indexPage: null,
    pages: 0,
    folders: 0,
    childTitles: [],
    relation: null,
    ...extra,
  };
}

const LEVELS: Record<string, GvLevel> = {
  '': {
    cards: [
      card('A', 'project', { indexPage: 'A/b.md' }),
      card('B', 'project'),
      card('C', 'project'),
      card('root.md'),
    ],
    centre: null,
  },
  A: { cards: [card('A/a.md'), card('A/b.md')], centre: null },
  B: { cards: [], centre: null },
  C: { cards: [card('C/c.md')], centre: null },
  'page:A/a.md': {
    cards: [
      card('A/a.md', 'page', { title: 'Generator Rex', relation: 'centre' }),
      card('root.md', 'page', { title: 'Sparda', relation: 'out' }),
    ],
    centre: 'A/a.md',
  },
  'page:root.md': {
    cards: [card('root.md', 'page', { title: 'Sparda', relation: 'centre' })],
    centre: 'root.md',
    omitted: 104,
  },
};

let calls: [string, Record<string, unknown>][];

beforeEach(() => {
  calls = [];
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
  useGvStore.getState().reset();
  useUiStore.setState({ screen: 'global' });
  mockIPC((cmd, raw) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    calls.push([cmd, args]);
    switch (cmd) {
      case 'gv_children': {
        const found = LEVELS[levelKey(args.level as GvLevelRef)];
        if (!found) throw { kind: 'notFound', message: 'x' };
        return found;
      }
      case 'gv_edges':
        return [];
      case 'layout_get':
        return {};
      case 'settings_set':
        return { ...useSettingsStore.getState().settings, ...(args.patch as object) };
      case 'page_get':
        return {
          path: args.path,
          title: 'a',
          subtitle: null,
          cover: null,
          coverY: null,
          coverX: null,
          coverSide: 'top',
          tags: [],
          links: 0,
          backlinks: 0,
          text: '',
          truncated: false,
          binary: false,
        };
      case 'page_read':
        return { text: '', hash: 'h' };
      case 'entry_create_page':
        return `${args.dir}/${args.name}.md`;
      case 'vault_tree':
        return [];
      default:
        return null;
    }
  });
});

afterEach(() => {
  usePageStore.getState().clear();
  usePageStore.getState().clearTitleFocus();
  clearMocks();
});

const cardButton = (name: string) => screen.findByRole('button', { name });

describe('Global View screen (M3a §5, §6)', () => {
  it('GV-10/14: level 0 shows the projects and root pages; a click drills in, the breadcrumb goes back', async () => {
    render(<GlobalView />);
    const nav = screen.getByRole('navigation', { name: 'Global View path' });
    await cardButton('A');
    expect(within(nav).getByText('Vault')).toHaveAttribute('aria-current', 'page');
    await userEvent.click(await cardButton('A'));
    await cardButton('a');
    expect(within(nav).getByRole('button', { name: 'Vault' })).toBeInTheDocument();
    expect(within(nav).getByText('A')).toHaveAttribute('aria-current', 'page');
    await userEvent.click(within(nav).getByRole('button', { name: 'Vault' }));
    await cardButton('root');
  });

  it('GV-12: a double click opens the page in the editor', async () => {
    render(<GlobalView />);
    await userEvent.dblClick(await cardButton('root'));
    await waitFor(() => expect(usePageStore.getState().path).toBe('root.md'));
    expect(useUiStore.getState().screen).toBe('edit');
  });

  it('GV-18: arrow keys move between cards, Enter opens, Escape goes back up', async () => {
    render(<GlobalView />);
    const a = await cardButton('A');
    act(() => a.focus());
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(await cardButton('B'));
    expect(screen.getByRole('button', { name: 'B' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('button', { name: 'A' })).toHaveAttribute('tabindex', '-1');
    await userEvent.keyboard('{ArrowLeft}{Enter}');
    await waitFor(async () => expect(document.activeElement).toBe(await cardButton('a')));
    await userEvent.keyboard('{Escape}');
    await waitFor(async () => expect(document.activeElement).toBe(await cardButton('A')));
  });

  it('GV-18: Escape puts the keyboard back on the card that opened the level (final review m13)', async () => {
    render(<GlobalView />);
    // The level arrives with the keyboard on its first card.
    await waitFor(async () => expect(document.activeElement).toBe(await cardButton('A')));
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    expect(document.activeElement).toBe(await cardButton('C'));
    await userEvent.keyboard('{Enter}');
    await waitFor(async () => expect(document.activeElement).toBe(await cardButton('c')));
    await userEvent.keyboard('{Escape}');
    await waitFor(async () => expect(document.activeElement).toBe(await cardButton('C')));
  });

  it('GV-13/21/32: mode, edge toggles and Reset layout', async () => {
    render(<GlobalView />);
    await cardButton('A');
    const drill = screen.getByRole('button', { name: 'Drill-down' });
    expect(drill).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Expand in place' }));
    expect(calls).toContainEqual(['settings_set', { patch: { globalViewMode: 'expand' } }]);
    await userEvent.click(screen.getByRole('button', { name: 'Parent / child' }));
    expect(calls).toContainEqual([
      'settings_set',
      { patch: { globalViewEdges: { links: true, tree: false, manual: true, aggregated: true } } },
    ]);
    expect(screen.getByRole('button', { name: 'Parent / child' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reset layout' }));
    expect(calls).toContainEqual(['layout_set', { level: 'expand:', positions: {} }]);
  });

  it('GV-17: New entry creates a page in the folder shown and opens it, title selected', async () => {
    render(<GlobalView />);
    await userEvent.click(await cardButton('A'));
    await cardButton('a');
    await userEvent.click(screen.getByRole('button', { name: 'New entry' }));
    await waitFor(() =>
      expect(calls).toContainEqual(['entry_create_page', { dir: 'A', name: 'Untitled' }]),
    );
    await waitFor(() => expect(usePageStore.getState().path).toBe('A/Untitled.md'));
    expect(useUiStore.getState().screen).toBe('edit');
    expect(usePageStore.getState().titleFocus).toEqual({ path: 'A/Untitled.md' });
  });

  it('a capped hub page says how many linked pages it leaves out (final review m14)', async () => {
    render(<GlobalView />);
    await cardButton('A');
    expect(screen.queryByText(/not shown/)).not.toBeInTheDocument();
    await act(() => useGvStore.getState().open(card('root.md', 'page', { title: 'Sparda' })));
    expect(await screen.findByText('104 more linked pages aren’t shown here.')).toHaveAttribute(
      'role',
      'status',
    );
  });

  it('an empty folder says so', async () => {
    render(<GlobalView />);
    await userEvent.click(await cardButton('B'));
    expect(await screen.findByText('Empty folder.')).toBeInTheDocument();
  });

  it('GV-14: earlier page crumbs keep their page title (final review m1)', async () => {
    render(<GlobalView />);
    await cardButton('A');
    await act(() => useGvStore.getState().open(card('A', 'project')));
    await act(() => useGvStore.getState().open(card('A/a.md', 'page', { title: 'Generator Rex' })));
    await act(() => useGvStore.getState().open(card('root.md', 'page', { title: 'Sparda' })));
    const nav = screen.getByRole('navigation', { name: 'Global View path' });
    expect(
      within(nav)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Vault', 'A', 'Generator Rex', 'Sparda']);
  });

  it('NFR-10: no axe violations', async () => {
    const { container } = render(<GlobalView />);
    await cardButton('A');
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});

describe('keyboard focus after leaving a level (final review I4)', () => {
  it('an empty level takes the keyboard; Escape goes back up to the card that opened it', async () => {
    render(<GlobalView />);
    await waitFor(async () => expect(document.activeElement).toBe(await cardButton('A')));
    await userEvent.keyboard('{ArrowRight}{Enter}');
    const note = await screen.findByText('Empty folder.');
    await waitFor(() => expect(document.activeElement).toBe(note));
    await userEvent.keyboard('{Escape}');
    await waitFor(async () => expect(document.activeElement).toBe(await cardButton('B')));
  });

  it('shown again (⌘2 from the editor), the keyboard is back on the last focused card', async () => {
    const first = render(<GlobalView />);
    await waitFor(async () => expect(document.activeElement).toBe(await cardButton('A')));
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(await cardButton('B'));
    first.unmount();
    // The editor is hidden, not unmounted: it may still hold the focus.
    const hidden = document.body.appendChild(document.createElement('div'));
    const editor = hidden.appendChild(document.createElement('div'));
    editor.tabIndex = 0;
    editor.focus();
    hidden.hidden = true;
    expect(document.activeElement).toBe(editor);
    try {
      render(<GlobalView />);
      await waitFor(async () => expect(document.activeElement).toBe(await cardButton('B')));
    } finally {
      hidden.remove();
    }
  });

  it('leaving with the keyboard in the view asks the editor to take it, unless New entry asked for the title', async () => {
    const view = render(<GlobalView />);
    await waitFor(async () => expect(document.activeElement).toBe(await cardButton('A')));
    view.unmount();
    expect(usePageStore.getState().editorFocus).toBe(true);
    act(() => usePageStore.getState().clearEditorFocus());
    const again = render(<GlobalView />);
    await waitFor(async () => expect(document.activeElement).toBe(await cardButton('A')));
    act(() => usePageStore.getState().requestTitleFocus('A/Untitled.md'));
    again.unmount();
    expect(usePageStore.getState().editorFocus).toBe(false);
    act(() => usePageStore.getState().clearTitleFocus());
  });
});

describe('a slow double click (final review I5)', () => {
  /** The first click drills in after 240 ms; the second press of the same
   *  double click (the OS still counts it) lands on the new level's card. */
  async function slowDoubleClick(name: string, landsOn: string) {
    fireEvent.click(await cardButton(name), { detail: 1 });
    const next = await cardButton(landsOn);
    fireEvent.click(next, { detail: 2 });
    fireEvent.dblClick(next, { detail: 2 });
  }

  it('opens the card double-clicked (its index note), not the card now under the pointer', async () => {
    render(<GlobalView />);
    await slowDoubleClick('A', 'a');
    await waitFor(() => expect(usePageStore.getState().path).toBe('A/b.md'));
    expect(useUiStore.getState().screen).toBe('edit');
  });

  it('on a folder without an index note, leaves it drilled in once', async () => {
    render(<GlobalView />);
    await slowDoubleClick('C', 'c');
    await new Promise((r) => setTimeout(r, 400)); // past a single click's wait
    expect(useGvStore.getState().stack).toEqual([{ kind: 'vault' }, { kind: 'folder', path: 'C' }]);
    expect(usePageStore.getState().path).toBeNull();
    expect(useUiStore.getState().screen).toBe('global');
  });
});

describe('a card’s connections menu (final review m9)', () => {
  it('opens inside the Global View region, a landmark', async () => {
    render(<GlobalView />);
    await userEvent.click(await cardButton('Connections of root'));
    expect(screen.getByRole('region', { name: 'Global View' })).toContainElement(
      screen.getByRole('menu', { name: 'Connections of root' }),
    );
  });

  it('closes when the canvas moves to another level', async () => {
    render(<GlobalView />);
    await userEvent.click(await cardButton('Connections of root'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    // root.md is the next level's centre card: it stays on the canvas.
    await act(() => useGvStore.getState().open(card('root.md')));
    expect(useGvStore.getState().shownKey).toBe('page:root.md');
    expect(await cardButton('Sparda')).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
