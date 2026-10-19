import type { Heading, Root, RootContent } from 'mdast';
import { sameHeading } from './headings';

export function text(node: RootContent): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('children' in node) return (node.children as RootContent[]).map(text).join('');
  return '';
}

/** The section under `heading` (case-insensitive, link-safe form matches
 *  too): the heading itself and everything until the next heading of the same
 *  or a higher level. */
export function sectionOf(tree: Root, heading: string): Root | null {
  const start = tree.children.findIndex(
    (n) => n.type === 'heading' && sameHeading(text(n), heading),
  );
  if (start < 0) return null;
  const depth = (tree.children[start] as Heading).depth;
  let end = start + 1;
  while (end < tree.children.length) {
    const n = tree.children[end];
    if (n.type === 'heading' && n.depth <= depth) break;
    end++;
  }
  return { type: 'root', children: tree.children.slice(start, end) };
}
