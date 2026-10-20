// See atoms (M4b part 3 §6) in the Global View: entering from a card, the
// map of a page, the jump into the editor, and back.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GvCard, GvEdge, GvLevel, GvLevelRef, LinkTarget } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { installReactFlowStubs } from '../../test/reactFlow';
import { GlobalView } from './GlobalView';
import { levelKey, useGvStore } from './gvStore';

beforeAll(installReactFlowStubs);

function card(path: string, extra: Partial<GvCard> = {}): GvCard {
  return {
    path,
    kind: 'page',
    title: path.split('/').pop()!.replace(/\.md$/, ''),
    subtitle: null,
    cover: null,
    coverRemote: false,
    coverY: null,
    coverSide: 'top',
    coverX: null,
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

const REX = [
  'Teen agent, see [[Sparda]].',
  '',
  '# Abilities',
  '',
  'Builds machines.',
  '',
  '![[rex.png]]',
  '',
  '## Weak spots',
  '',
  '- water',
  '- magnets',
  '',
].join('\n');

const LEVELS: Record<string, GvLevel> = {
  '': { cards: [card('Rex.md'), card('Sparda.md'), card('Other.md')], centre: null },
  'page:Rex.md': {
    cards: [
      card('Rex.md', { relation: 'centre' }),
      card('Sparda.md', { relation: 'out' }),
      card('Fan.md', { relation: 'in' }),
      card('Mentor.md', { relation: 'out' }),
    ],
    centre: 'Rex.md',
  },
  'page:Sparda.md': { cards: [card('Sparda.md', { relation: 'centre' })], centre: 'Sparda.md' },
};

const RELATED: GvEdge[] = [
  {
    from: 'Rex.md',
    to: 'Mentor.md',
    kind: 'manual',
    count: 1,
    aggregated: false,
    directed: true,
    label: 'learns from',
  },
];

let reads: string[];
/** How `page_read` returns Rex: as written, or saved with Windows line ends. */
let rexOnDisk: string;

beforeEach(() => {
  reads = [];
  rexOnDisk = REX;
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
  useGvStore.getState().reset();
  useUiStore.setState({ screen: 'global' });
  mockIPC((cmd, raw) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case 'gv_children': {
        const found = LEVELS[levelKey(args.level as GvLevelRef)];
        if (!found) throw { kind: 'notFound', message: 'x' };
        return found;
      }
      case 'gv_edges':
        return (args.visible as string[]).includes('Mentor.md') ? RELATED : [];
      case 'layout_get':
        return {};
      case 'links_resolve':
        return (args.targets as LinkTarget[]).map(({ target }) =>
          target === 'Sparda' ? 'Sparda.md' : target === 'rex.png' ? 'assets/rex.png' : null,
        );
      case 'page_read':
        reads.push(args.path as string);
        return { text: args.path === 'Rex.md' ? rexOnDisk : '', hash: 'h' };
      case 'page_get':
        return {
          path: args.path,
          title: 'Rex',
          subtitle: null,
          cover: null,
          coverY: null,
          tags: [],
          links: 0,
          backlinks: 0,
          text: REX,
          truncated: false,
          binary: false,
        };
      case 'vault_tree':
        return [];
      default:
        return null;
    }
  });
});

afterEach(() => {
  usePageStore.getState().clear();
  usePageStore.getState().clearJump();
  clearMocks();
});

const atomsOf = async () => {
  render(<GlobalView />);
  await userEvent.click(await screen.findByRole('button', { name: 'See atoms of Rex' }));
  return screen.findByRole('application', { name: 'Atoms of Rex' });
};

describe('See atoms (M4b part 3 §6)', () => {
  it("a page card's Atoms button shows its sections, blocks and linked pages", async () => {
    await atomsOf();
    expect(useGvStore.getState().atoms).toEqual({ path: 'Rex.md', title: 'Rex' });
    await screen.findByRole('button', { name: 'Heading 1: Abilities' });
    expect(screen.getByRole('button', { name: 'Heading 2: Weak spots' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Paragraph: Teen agent, see Sparda.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Image: rex.png' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'List: water, magnets' })).toBeInTheDocument();
    // Linked from a block, and related; a backlink alone isn't shown.
    expect(screen.getByRole('button', { name: 'Sparda' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mentor' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fan' })).not.toBeInTheDocument();
    // The image's thumbnail is its vault file.
    const image = screen.getByRole('group', { name: 'Image' });
    expect(image.querySelector('img')?.getAttribute('src')).toBe(
      'liber-asset://localhost/assets/rex.png',
    );

    // Structure: page → intro, Abilities; Abilities → 2 blocks, Weak spots → 1 block.
    await waitFor(() => expect(document.querySelectorAll('[data-gv-edge="tree"]')).toHaveLength(6));
    const link = document.querySelector('[data-gv-edge="link"]')!;
    expect([link.getAttribute('data-a'), link.getAttribute('data-b')]).toEqual([
      'atom:0',
      'Sparda.md',
    ]);
    expect(document.querySelector('[data-gv-edge="manual"]')).toHaveAttribute(
      'data-b',
      'Mentor.md',
    );

    // The breadcrumb: the levels, the page, and Atoms here; no mode or connecting.
    const nav = screen.getByRole('navigation', { name: 'Global View path' });
    expect(within(nav).getByRole('button', { name: 'Vault' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Rex' })).toBeInTheDocument();
    expect(within(nav).getByText('Atoms')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('group', { name: 'Next level' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect cards' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New entry' })).not.toBeInTheDocument();
  });

  it('a click on a block opens the page with the cursor on it', async () => {
    await atomsOf();
    await userEvent.click(await screen.findByRole('button', { name: 'List: water, magnets' }));
    await waitFor(() => expect(useUiStore.getState().screen).toBe('edit'));
    const from = REX.indexOf('- water');
    expect(usePageStore.getState().path).toBe('Rex.md');
    expect(usePageStore.getState().jump).toMatchObject({
      path: 'Rex.md',
      from,
      to: REX.indexOf('magnets') + 'magnets'.length,
    });
  });

  // Final review I2: the editor holds LF text, so offsets taken from a CRLF
  // file's raw text landed one character later per line break above.
  it('a CRLF note jumps to the block clicked, at its offset in the editor (LF) text', async () => {
    rexOnDisk = REX.replace(/\n/g, '\r\n');
    await atomsOf();
    await userEvent.click(await screen.findByRole('button', { name: 'List: water, magnets' }));
    await waitFor(() => expect(useUiStore.getState().screen).toBe('edit'));
    expect(usePageStore.getState().jump).toMatchObject({
      path: 'Rex.md',
      from: REX.indexOf('- water'),
      to: REX.indexOf('magnets') + 'magnets'.length,
    });
  });

  it('a section opens its heading; Escape goes back to the level, the keyboard on the card', async () => {
    await atomsOf();
    const abilities = await screen.findByRole('button', { name: 'Heading 1: Abilities' });
    abilities.focus();
    fireEvent.keyDown(abilities, { key: 'Escape' });
    await waitFor(() => expect(useGvStore.getState().atoms).toBeNull());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rex' })).toHaveFocus());
    await userEvent.click(await screen.findByRole('button', { name: 'See atoms of Rex' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Heading 1: Abilities' }));
    await waitFor(() =>
      expect(usePageStore.getState().jump).toMatchObject({ from: REX.indexOf('Abilities') }),
    );
  });

  it("a linked page's card shows its own atoms; the page crumb opens the page's level", async () => {
    await atomsOf();
    await userEvent.click(await screen.findByRole('button', { name: 'Sparda' }));
    // A single click waits for a double click.
    await waitFor(() => expect(useGvStore.getState().atoms?.path).toBe('Sparda.md'));
    await screen.findByRole('application', { name: 'Atoms of Sparda' });
    const nav = screen.getByRole('navigation', { name: 'Global View path' });
    await userEvent.click(within(nav).getByRole('button', { name: 'Sparda' }));
    await waitFor(() => expect(useGvStore.getState().atoms).toBeNull());
    expect(useGvStore.getState().stack).toEqual([
      { kind: 'vault' },
      { kind: 'page', path: 'Sparda.md' },
    ]);
  });

  it('the card menu offers See atoms too', async () => {
    render(<GlobalView />);
    await screen.findByRole('button', { name: 'See atoms of Rex' });
    expect(useGvStore.getState().atoms).toBeNull();
    useGvStore.getState().seeAtoms('Rex.md', 'Rex');
    await screen.findByRole('application', { name: 'Atoms of Rex' });
  });

  it('NFR-10: the atoms map has no axe violations', async () => {
    await atomsOf();
    await screen.findByRole('button', { name: 'Heading 1: Abilities' });
    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it('follows edits: a saved change re-reads the page', async () => {
    await atomsOf();
    await screen.findByRole('button', { name: 'Heading 1: Abilities' });
    const before = reads.length;
    const { useVaultStore } = await import('../../stores/vaultStore');
    useVaultStore.setState({ nodes: [] });
    await waitFor(() => expect(reads.length).toBeGreaterThan(before));
  });
});
