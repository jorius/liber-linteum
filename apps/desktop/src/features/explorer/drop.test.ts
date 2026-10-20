import { afterEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { childrenByParent } from '../../stores/tree';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { dropEntry, planDrop } from './drop';

describe('planDrop (EXP-02 drag-and-drop rules)', () => {
  it('moves into another folder or the root, keeping the name', () => {
    expect(planDrop('Art/rex.md', 'Games')).toBe('Games/rex.md');
    expect(planDrop('Art/rex.md', '')).toBe('rex.md');
    expect(planDrop('Art/DMC', 'Games')).toBe('Games/DMC');
  });

  it('refuses drops onto itself, its current folder or its own descendant', () => {
    expect(planDrop('Art/rex.md', 'Art')).toBeNull();
    expect(planDrop('rex.md', '')).toBeNull();
    expect(planDrop('Art', 'Art')).toBeNull();
    expect(planDrop('Art', 'Art/DMC')).toBeNull();
    expect(planDrop('Art', 'Art/DMC/Deep')).toBeNull();
  });

  it('does not confuse sibling prefixes with descendants', () => {
    expect(planDrop('Art', 'Artwork')).toBe('Artwork/Art');
  });
});

describe('dropping onto a page (round 3 §9.3)', () => {
  const seed = (paths: [string, 'page' | 'folder'][]) => {
    const list = paths.map(([path, kind]) => ({ path, kind }));
    useVaultStore.setState({ nodes: list, children: childrenByParent(list) });
  };
  afterEach(() => resetVaultStore());

  it('goes into the folder the page heads, made or not yet made', () => {
    seed([
      ['Notes', 'folder'],
      ['Notes/P.md', 'page'],
      ['Lore', 'folder'],
      ['Lore/Lore.md', 'page'],
      ['Art', 'folder'],
      ['Art/rex.md', 'page'],
    ]);
    expect(planDrop('Art/rex.md', 'Notes/P.md')).toBe('Notes/P/rex.md');
    expect(planDrop('Art/rex.md', 'Lore/Lore.md')).toBe('Lore/rex.md');
    expect(planDrop('Art', 'Notes/P.md')).toBe('Notes/P/Art');
  });

  it('refuses itself, its own folder page, where it already is, and the Archive', () => {
    seed([
      ['Notes', 'folder'],
      ['Notes/P.md', 'page'],
      ['Notes/P', 'folder'],
      ['Notes/P/a.md', 'page'],
      ['X', 'folder'],
      ['X/X.md', 'page'],
      ['.archive', 'folder'],
      ['.archive/Old.md', 'page'],
      ['b.md', 'page'],
    ]);
    expect(planDrop('Notes/P.md', 'Notes/P.md')).toBeNull();
    expect(planDrop('X', 'X/X.md')).toBeNull();
    expect(planDrop('Notes/P/a.md', 'Notes/P.md')).toBeNull();
    expect(planDrop('b.md', '.archive/Old.md')).toBeNull();
    expect(planDrop('.archive/Old.md', 'Notes/P.md')).toBeNull();
  });

  it('dropEntry moves under a page in one command (review #1)', async () => {
    seed([
      ['P.md', 'page'],
      ['a.md', 'page'],
    ]);
    const calls: [string, unknown][] = [];
    const outcome = { moved: [], updatedFiles: [], updatedLinks: 0, failed: [], pair: null };
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'entry_move_under_page')
        return { folder: 'P', page: 'P/P.md', converted: outcome, moved: outcome };
      if (cmd === 'vault_tree') return [];
      return null;
    });
    expect(await dropEntry('a.md', 'P.md')).toBe(true);
    expect(calls.filter(([c]) => c.startsWith('entry_'))).toEqual([
      ['entry_move_under_page', { item: 'a.md', page: 'P.md' }],
    ]);
    clearMocks();
  });

  it('a refused move under a page leaves the page where it was (review #1)', async () => {
    seed([
      ['Projects.md', 'page'],
      ['projects', 'folder'],
      ['projects/a.md', 'page'],
    ]);
    const calls: string[] = [];
    mockIPC((cmd) => {
      calls.push(cmd);
      if (cmd === 'entry_move_under_page')
        throw { kind: 'alreadyExists', message: 'projects/a.md' };
      return null;
    });
    expect(await dropEntry('projects/a.md', 'Projects.md')).toBe(false);
    expect(calls).not.toContain('entry_rename');
    expect(calls).not.toContain('entry_make_folder_page');
    clearMocks();
  });
});
