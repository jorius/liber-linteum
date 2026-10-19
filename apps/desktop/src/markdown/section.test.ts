import type { Heading, Root } from 'mdast';
import { describe, expect, it } from 'vitest';
import { parsePage } from './parse';
import { sectionOf } from './section';

const headings = (tree: Root) =>
  tree.children.filter((n): n is Heading => n.type === 'heading').map((h) => h.depth);

describe('sectionOf (embeds of ![[Note#Heading]])', () => {
  const src = '# Top\nintro\n## Plot\nplot text\n### Act 1\nact\n## Cast\ncast text\n';

  it('takes the heading and everything up to the next heading of the same or higher level', () => {
    const section = sectionOf(parsePage(src).tree, 'plot')!;
    expect(headings(section)).toEqual([2, 3]);
    expect(JSON.stringify(section)).toContain('act');
    expect(JSON.stringify(section)).not.toContain('cast text');
  });

  it('M2c §6.2: a link-safe heading (brackets, pipes, # and ^ dropped) finds its section', () => {
    const tree = parsePage('## Pipes | and ^carets\nbody\n## Next\n').tree;
    expect(JSON.stringify(sectionOf(tree, 'pipes and carets'))).toContain('body');
  });

  it('returns null for a missing heading', () => {
    expect(sectionOf(parsePage(src).tree, 'Nope')).toBeNull();
  });
});
