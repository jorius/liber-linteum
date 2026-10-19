import { describe, expect, it } from 'vitest';
import { isTextPath } from './textFiles';

describe('text file names (M4b part 2 §6, same as Rust)', () => {
  it('by extension or whole name', () => {
    for (const yes of [
      'a.txt',
      'dir/b.JSON',
      'c.yml',
      'd.tsx',
      'Dockerfile',
      'x/Makefile',
      '.gitignore',
    ])
      expect(isTextPath(yes), yes).toBe(true);
    for (const no of ['a.md', 'b.png', 'README', 'd.txt.bak', 'dockerfile.png', '.txt'])
      expect(isTextPath(no), no).toBe(false);
  });
});
