// Connecting cards (M3b §2): Connect to… then a card (click or keyboard), or
// a drag from the connect handle; the relationship goes into the source
// page's related: and the canvas re-reads its edges.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GvCard, GvLevel, GvLevelRef } from '../../ipc';
import { clearMocks } from '../../ipc/testing';
import { resetEditorStore } from '../../stores/editorStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { fakeDisk, type FakeDisk } from '../../test/fakeDisk';
import { installReactFlowStubs } from '../../test/reactFlow';
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

beforeEach(() => {
  edgeReads = 0;
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
        return [];
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
});
