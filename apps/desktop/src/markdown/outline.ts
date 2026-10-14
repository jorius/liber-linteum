// The page outline (M4b part 2 §5): its headings from the parsed model, so
// fences, front matter and `%%` comments never add one.
import type { Heading, Nodes, Parent } from 'mdast';
import type { ParsedPage } from './types';

export interface OutlineHeading {
  level: number;
  text: string;
  /** Start of the heading's line. */
  from: number;
  /** Where the cursor goes: the start of its text (after `#`s). */
  at: number;
}

/** Plain text of inline content: link labels, code and maths as written. */
export function plainText(node: Nodes): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
    case 'inlineMath':
      return node.value;
    case 'wikiLink':
      return node.alias ?? node.target;
    case 'tag':
      return `#${node.name}`;
    case 'image':
      return node.alt ?? '';
    case 'break':
      return ' ';
    case 'embed':
    case 'html':
      return '';
    default:
      return 'children' in node ? (node.children as Nodes[]).map(plainText).join('') : '';
  }
}

/** Containers whose headings belong to the page's sections. */
const SECTIONS = new Set(['root', 'columns', 'column']);

export function headingsOf(page: ParsedPage, text: string): OutlineHeading[] {
  const out: OutlineHeading[] = [];
  const walk = (parent: Parent) => {
    for (const node of parent.children as Nodes[]) {
      if (node.type === 'heading') {
        const from = (node as Heading).position!.start.offset!;
        const marker = /^[ \t]{0,3}#{1,6}[ \t]*/.exec(text.slice(from, from + 16));
        out.push({
          level: node.depth,
          text: plainText(node).replace(/\s+/g, ' ').trim(),
          from,
          at: from + (marker ? marker[0].length : 0),
        });
      } else if (SECTIONS.has(node.type)) {
        walk(node as Parent);
      }
    }
  };
  walk(page.tree);
  return out;
}

/** Index of each heading's parent (the nearest earlier one of a lower level), or -1. */
export function parentsOf(items: OutlineHeading[]): number[] {
  const stack: number[] = [];
  return items.map((h, i) => {
    while (stack.length && items[stack[stack.length - 1]].level >= h.level) stack.pop();
    const parent = stack.length ? stack[stack.length - 1] : -1;
    stack.push(i);
    return parent;
  });
}

/** The heading whose section holds `pos`, or -1 above the first one. */
export function headingAt(items: OutlineHeading[], pos: number): number {
  let found = -1;
  for (let i = 0; i < items.length && items[i].from <= pos; i++) found = i;
  return found;
}
