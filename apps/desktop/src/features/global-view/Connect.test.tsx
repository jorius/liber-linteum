// Connecting cards (M3b §2): Connect to… then a card (click or keyboard), or
// a drag from the connect handle; the relationship goes into the source
// page's related: and the canvas re-reads its edges.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GvCard, GvEdge, GvLevel, GvLevelRef } from '../../ipc';
import { clearMocks } from '../../ipc/testing';
import { resetEditorStore } from '../../stores/editorStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { fakeDisk, type FakeDisk } from '../../test/fakeDisk';
import { installReactFlowStubs } from '../../test/reactFlow';
import { DialogHost } from '../dialogs/DialogHost';
import { Toaster } from '../toasts/Toaster';
import { SINGLE_CLICK_MS } from './Card';
import { GlobalView } from './GlobalView';
import { levelKey, useGvStore } from './gvStore';

beforeAll(installReactFlowStubs);

function card(path: string, extra: Partial<GvCard> = {}): GvCard {
  return {
    path,
    kind: 'page',
    title: path.replace(/\.md$/, ''),
    subtitle: null,
    cover: null,
    coverRemote: false,
    coverY: null,
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
      card('Delta', { kind: 'project', title: 'Delta', pages: 2 }),
      card('Gamma', {
        kind: 'project',
        title: 'Gamma',
        indexPage: 'Gamma/b.md',
        indexFrom: 'picked',
      }),
      card('A.md'),
      card('B.md'),
    ],
    centre: null,
  },
};

let disk: FakeDisk;
let edgeReads = 0;
let edges: GvEdge[] = [];

beforeEach(() => {
  edgeReads = 0;
  edges = [];
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
  useGvStore.getState().reset();
  useUiStore.setState({ screen: 'global', dialog: null });
  useToastStore.getState().clear();
  disk = fakeDisk(
    { 'A.md': '# A\n', 'B.md': '# B\n', 'Gamma/b.md': '# Gamma B\n' },
    {
      gv_children: (a) => {
        const level = LEVELS[levelKey(a.level as unknown as GvLevelRef)];
        if (!level) throw { kind: 'notFound', message: 'x' };
        return level;
      },
      gv_edges: () => {
        edgeReads++;
        return edges;
      },
      layout_get: () => ({}),
      link_target: (a) => String(a.target).replace(/\.md$/, ''),
      links_resolve: (a) =>
        (a.targets as unknown as { target: string }[]).map((t) => `${t.target}.md`),
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  resetEditorStore();
  clearMocks();
});

const press = async (path: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-gv-card="${CSS.escape(path)}"]`);
    if (!el) throw new Error(`no card ${path}`);
    return el;
  });

/** The level is shown and has put the keyboard on its first card: a button
 *  focused before that loses the keyboard to it. */
const settled = () => waitFor(() => expect(document.activeElement).toHaveAttribute('data-gv-card'));

async function startConnect(title: string) {
  await userEvent.click(await screen.findByRole('button', { name: `Connections of ${title}` }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Connect to…' }));
}

describe('connecting two cards (M3b §2)', () => {
  it('Connect to…, then a click on another card: the source page gains the relationship', async () => {
    render(<GlobalView />);
    await startConnect('A');
    const bar = screen.getByRole('status', { name: 'Connecting' });
    expect(bar).toHaveTextContent('Pick the card to connect: A → ?');
    const reads = edgeReads;
    // A single click on B completes it (no drill-down).
    fireEvent.click(await press('B.md'));
    await waitFor(() =>
      expect(disk.files.get('A.md')).toBe('---\nrelated:\n  - "[[B]]"\n---\n# A\n'),
    );
    expect(screen.queryByRole('status', { name: 'Connecting' })).not.toBeInTheDocument();
    expect(useGvStore.getState().stack).toEqual([{ kind: 'vault' }]);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
      'Relationship created.',
    );
    await waitFor(() => expect(edgeReads).toBeGreaterThan(reads));
  });

  it('by keyboard: Enter on Connect to…, arrows to the target, Enter', async () => {
    render(<GlobalView />);
    const button = await screen.findByRole('button', { name: 'Connections of A' });
    await settled();
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('menuitem', { name: 'Connect to…' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    // The keyboard goes back to the source card, and moves on from there.
    await waitFor(async () => expect(await press('A.md')).toHaveFocus());
    await userEvent.keyboard('{ArrowRight}{Enter}');
    await waitFor(() => expect(disk.files.get('A.md')).toContain('"[[B]]"'));
  });

  it('Escape or Cancel leaves connect mode; a click on the source card keeps it', async () => {
    render(<GlobalView />);
    await startConnect('A');
    fireEvent.click(await press('A.md'));
    await act(() => new Promise((r) => setTimeout(r, SINGLE_CLICK_MS + 20)));
    expect(screen.getByRole('status', { name: 'Connecting' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('status', { name: 'Connecting' })).not.toBeInTheDocument();
    await startConnect('A');
    (await press('B.md')).focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('status', { name: 'Connecting' })).not.toBeInTheDocument();
    expect(useGvStore.getState().stack).toEqual([{ kind: 'vault' }]);
    expect(disk.writes()).toEqual([]);
  });

  it('a folder stands for its index note; one without can’t take part', async () => {
    render(<GlobalView />);
    await startConnect('A');
    fireEvent.click(await press('Gamma'));
    await waitFor(() => expect(disk.files.get('A.md')).toContain('"[[Gamma/b]]"'));
    await startConnect('A');
    fireEvent.click(await press('Delta'));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
        'Delta has no index note. Pick one first.',
      ),
    );
    expect(screen.queryByRole('status', { name: 'Connecting' })).not.toBeInTheDocument();
  });

  it('a relationship that already exists opens its dialog instead of a duplicate', async () => {
    disk.files.set('A.md', '---\nrelated:\n  - "[[B]]"\n---\n# A\n');
    render(<GlobalView />);
    await startConnect('A');
    fireEvent.click(await press('B.md'));
    await waitFor(() =>
      expect(useUiStore.getState().dialog).toEqual({
        type: 'relations',
        page: 'A.md',
        other: 'B.md',
      }),
    );
    expect(disk.writes()).toEqual([]);
  });

  it('a drag from the connect handle onto a card relates them (connectByDrag)', async () => {
    render(<GlobalView />);
    await press('A.md');
    await act(() => useGvStore.getState().connectByDrag('A.md', 'B.md'));
    await waitFor(() => expect(disk.files.get('A.md')).toContain('"[[B]]"'));
    // Dropped on itself or on nothing: no relationship.
    await act(() => useGvStore.getState().connectByDrag('B.md', 'B.md'));
    await act(() => useGvStore.getState().connectByDrag('B.md', null));
    expect(disk.writes().filter((w) => w.path === 'B.md')).toEqual([]);
  });

  it('the source card is marked while connecting', async () => {
    render(<GlobalView />);
    await startConnect('A');
    const group = screen.getByRole('group', { name: 'A, page' });
    expect(group).toHaveAttribute('data-connecting');
    expect(within(group).getByRole('button', { name: 'A' })).toBeInTheDocument();
  });

  it('a folder without an index note offers to pick one (menu and toast action)', async () => {
    render(<GlobalView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Connections of Delta' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Connect to…',
      'Pick index note…',
    ]);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Connect to…' }));
    const toast = useToastStore.getState().toasts.at(-1)!;
    expect(toast.action?.label).toBe('Pick index note…');
    act(() => toast.action!.run());
    expect(useUiStore.getState().dialog).toEqual({
      type: 'indexPick',
      folder: 'Delta',
      current: null,
    });
    // A picked index note can be changed too.
    await userEvent.click(screen.getByRole('button', { name: 'Connections of Gamma' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Pick index note…' }));
    expect(useUiStore.getState().dialog).toEqual({
      type: 'indexPick',
      folder: 'Gamma',
      current: 'Gamma/b.md',
    });
  });
});

describe('connect-mode corner cases (final review m8)', () => {
  const connecting = () => useGvStore.getState().connectFrom !== null;

  it('a folder and its index note’s own card are the same page: connect mode stays on, and says so', async () => {
    const level = LEVELS[''];
    LEVELS[''] = { ...level, cards: [...level.cards, card('Gamma/b.md', { title: 'Gamma B' })] };
    try {
      render(<GlobalView />);
      await startConnect('Gamma');
      fireEvent.click(await press('Gamma/b.md'));
      const note = 'Gamma and Gamma B stand for the same page: it can’t be related to itself.';
      await waitFor(() =>
        expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(note),
      );
      expect(useToastStore.getState().toasts.find((t) => t.message === note)?.tone).toBe('info');
      expect(connecting()).toBe(true);
      expect(screen.getByRole('status', { name: 'Connecting' })).toBeVisible();
      // A drag says so too.
      useToastStore.getState().clear();
      await act(() => useGvStore.getState().connectByDrag('Gamma/b.md', 'Gamma'));
      expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
        'Gamma B and Gamma stand for the same page: it can’t be related to itself.',
      ]);
      expect(disk.writes()).toEqual([]);
    } finally {
      LEVELS[''] = level;
    }
  });

  it('a slow double click on the target only connects: the page doesn’t open', async () => {
    render(<GlobalView />);
    await startConnect('A');
    fireEvent.click(await press('B.md'), { detail: 1 });
    // The single click's wait runs out: that completes the connection.
    await waitFor(() => expect(disk.files.get('A.md')).toContain('"[[B]]"'));
    fireEvent.click(await press('B.md'), { detail: 2 });
    fireEvent.dblClick(await press('B.md'), { detail: 2 });
    await act(() => new Promise((r) => setTimeout(r, SINGLE_CLICK_MS + 20)));
    expect(useUiStore.getState().screen).toBe('global');
    expect(disk.calls.map(([cmd]) => cmd)).not.toContain('page_get');
  });

  it('a click on a relationship edge leaves connect mode and opens its dialog', async () => {
    disk.files.set('A.md', '---\nrelated:\n  - "[[B]]"\n---\n# A\n');
    edges = [
      {
        from: 'A.md',
        to: 'B.md',
        kind: 'manual',
        aggregated: false,
        directed: false,
        count: 1,
        label: null,
      },
    ];
    render(<GlobalView />);
    await startConnect('A');
    const hit = await waitFor(() => {
      const el = document.querySelector('[data-gv-hit]');
      if (!el) throw new Error('no edge yet');
      return el;
    });
    fireEvent.click(hit);
    expect(connecting()).toBe(false);
    expect(useUiStore.getState().dialog).toEqual({
      type: 'relations',
      page: 'A.md',
      other: 'B.md',
    });
  });

  it('a re-read of the level keeps connect mode and the keyboard where they are', async () => {
    render(<GlobalView />);
    await startConnect('A');
    (await press('B.md')).focus();
    // Each read answers new card objects.
    const level = LEVELS[''];
    LEVELS[''] = structuredClone(level);
    try {
      await act(() => useGvStore.getState().load());
    } finally {
      LEVELS[''] = level;
    }
    expect(connecting()).toBe(true);
    expect(await press('B.md')).toHaveFocus();
  });

  it('leaving the Global View (⌘1) or the source card’s level ends connect mode', async () => {
    const view = render(<GlobalView />);
    await startConnect('A');
    view.unmount();
    expect(connecting()).toBe(false);

    render(<GlobalView />);
    await startConnect('B');
    // B is gone from the level when it's read again (deleted, moved away).
    const level = LEVELS[''];
    LEVELS[''] = { ...level, cards: level.cards.filter((c) => c.path !== 'B.md') };
    try {
      await act(() => useGvStore.getState().load());
      expect(connecting()).toBe(false);
      expect(screen.queryByRole('status', { name: 'Connecting' })).not.toBeInTheDocument();
    } finally {
      LEVELS[''] = level;
    }
  });
});

describe('Escape anywhere in the view leaves connect mode (final review m3)', () => {
  const connecting = () => useGvStore.getState().connectFrom !== null;

  it('from the Cancel button, a connect button or the toolbar', async () => {
    render(<GlobalView />);
    for (const target of [
      () => screen.getByRole('button', { name: 'Cancel' }),
      () => screen.getByRole('button', { name: 'Connections of B' }),
      () => screen.getByRole('button', { name: 'Drill-down' }),
    ]) {
      await startConnect('A');
      expect(connecting()).toBe(true);
      target().focus();
      await userEvent.keyboard('{Escape}');
      expect(connecting()).toBe(false);
    }
    expect(useGvStore.getState().stack).toEqual([{ kind: 'vault' }]);
  });

  it('leaving from the bar puts the keyboard back on the source card, not on the page', async () => {
    render(<GlobalView />);
    await startConnect('A');
    screen.getByRole('button', { name: 'Cancel' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(await press('A.md')).toHaveFocus();
    await startConnect('A');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(connecting()).toBe(false);
    expect(await press('A.md')).toHaveFocus();
  });
});

describe('the keyboard after a menu item (NFR-10, final review I2)', () => {
  const view = () =>
    render(
      <>
        <GlobalView />
        <DialogHost />
        <Toaster />
      </>,
    );
  /** Opens a card's menu by keyboard and runs the item `name`. */
  async function runItem(title: string, name: string) {
    const button = await screen.findByRole('button', { name: `Connections of ${title}` });
    await settled();
    button.focus();
    await userEvent.keyboard('{Enter}');
    while (document.activeElement !== screen.getByRole('menuitem', { name })) {
      await userEvent.keyboard('{ArrowDown}');
    }
    await userEvent.keyboard('{Enter}');
    return button;
  }

  it('Relationships…, then Escape or Close: back on the card’s connect button', async () => {
    disk.files.set('A.md', '---\nrelated:\n  - "[[B]]"\n---\n# A\n');
    view();
    const button = await runItem('A', 'Relationships…');
    const dialog = await screen.findByRole('dialog', { name: 'Relationships of A' });
    await within(dialog).findByRole('group', { name: 'A → B' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(button).toHaveFocus();
  });

  it('Pick index note…, then Cancel: back on the card’s connect button', async () => {
    view();
    const button = await runItem('Gamma', 'Pick index note…');
    const dialog = await screen.findByRole('dialog', { name: 'Index note for Gamma' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button).toHaveFocus();
  });

  it('Connect to… on a folder without an index note keeps the keyboard on its button; the toast’s Pick index note… brings it back there', async () => {
    view();
    const button = await runItem('Delta', 'Connect to…');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(button).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Pick index note…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Index note for Delta' });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Connections of Delta' })).toHaveFocus();
  });
});
