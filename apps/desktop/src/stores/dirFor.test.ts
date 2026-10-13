import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../ipc';
import { dirFor } from './tree';

const nodes: TreeNode[] = [
  { path: 'Art', kind: 'folder' },
  { path: 'Art/rex.md', kind: 'page' },
];

describe('dirFor', () => {
  it('is the folder itself, the parent of a file, or the root', () => {
    expect(dirFor(nodes, 'Art')).toBe('Art');
    expect(dirFor(nodes, 'Art/rex.md')).toBe('Art');
    expect(dirFor(nodes, null)).toBe('');
    expect(dirFor(nodes, 'gone.md')).toBe('');
  });
});
