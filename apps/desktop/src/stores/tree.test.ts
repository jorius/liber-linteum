import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../ipc';
import {
  childrenByParent,
  folderPageOf,
  joinPath,
  nameOf,
  nextFreeName,
  parentOf,
  remap,
} from './tree';

const nodes: TreeNode[] = [
  { path: 'Projects', kind: 'folder' },
  { path: 'Untitled.md', kind: 'page' },
  { path: 'untitled 1.md', kind: 'page' },
  { path: 'Projects/Untitled', kind: 'folder' },
  { path: 'Projects/a.md', kind: 'page' },
];

describe('tree helpers', () => {
  it('splits and joins vault paths', () => {
    expect(parentOf('a/b/c.md')).toBe('a/b');
    expect(parentOf('c.md')).toBe('');
    expect(nameOf('a/b/c.md')).toBe('c.md');
    expect(joinPath('', 'x.md')).toBe('x.md');
    expect(joinPath('a', 'x.md')).toBe('a/x.md');
  });

  it('groups children by parent, keeping backend order', () => {
    const map = childrenByParent(nodes);
    expect(map.get('')?.map((n) => n.path)).toEqual(['Projects', 'Untitled.md', 'untitled 1.md']);
    expect(map.get('Projects')?.map((n) => n.path)).toEqual(['Projects/Untitled', 'Projects/a.md']);
  });

  it('EXP-02 proposes the first free Untitled name (case-insensitive)', () => {
    expect(nextFreeName(nodes, '', 'Untitled', '.md')).toBe('Untitled 2');
    expect(nextFreeName(nodes, 'Projects', 'Untitled', '.md')).toBe('Untitled');
    expect(nextFreeName(nodes, 'Projects', 'Untitled', '')).toBe('Untitled 1');
    expect(nextFreeName(nodes, 'Empty', 'Untitled', '')).toBe('Untitled');
  });

  it('remaps paths through a rename of a file or folder', () => {
    expect(remap('a/b.md', 'a/b.md', 'c/b.md')).toBe('c/b.md');
    expect(remap('a/b/c.md', 'a/b', 'x')).toBe('x/c.md');
    expect(remap('a/bc.md', 'a/b', 'x')).toBeNull();
    expect(remap('z.md', 'a', 'b')).toBeNull();
  });
});

describe('folder pages (round 3b §6.1)', () => {
  const list = (paths: string[]): TreeNode[] =>
    paths.map((path) => ({ path, kind: path.endsWith('.md') ? 'page' : 'folder' }));

  it('folderPageOf finds X/X.md, or a page whose name differs only in case (round 3 §9)', () => {
    const children = childrenByParent(
      list(['X', 'X/X.md', 'Y', 'Y/y.md', 'Z', 'Z.md', 'A/B', 'A/B/B.md', 'Á', 'Á/á.md']),
    );
    expect(folderPageOf('X', children)).toBe('X/X.md');
    expect(folderPageOf('Y', children)).toBe('Y/y.md');
    expect(folderPageOf('Á', children)).toBe('Á/á.md');
    expect(folderPageOf('Z', children)).toBeNull();
    expect(folderPageOf('A/B', children)).toBe('A/B/B.md');
    expect(folderPageOf('', children)).toBeNull();
  });

  it('an exact name wins over a case variant; folders never count', () => {
    const children = childrenByParent([
      ...list(['X', 'X/x.md', 'X/X.md', 'W']),
      { path: 'W/W.md', kind: 'folder' },
    ]);
    expect(folderPageOf('X', children)).toBe('X/X.md');
    expect(folderPageOf('W', children)).toBeNull();
  });
});
