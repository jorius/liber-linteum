// Word count (M4b part 2 §5): the prose of the parsed model — front matter,
// `%%` comments, Markdown syntax and link URLs left out; code and maths
// counted as text; each CJK character a word.
import type { Nodes, Parent } from 'mdast';
import type { ParsedPage } from './types';

export const WORDS_PER_MINUTE = 230;

interface Leaf {
  from: number;
  to: number;
  value: string;
}

const leavesOf = new WeakMap<ParsedPage, Leaf[]>();

/** The text-bearing leaves of the tree, in source order. */
function leaves(page: ParsedPage): Leaf[] {
  const known = leavesOf.get(page);
  if (known) return known;
  const out: Leaf[] = [];
  const add = (node: Nodes, value: string) => {
    const p = node.position;
    if (p?.start.offset !== undefined && p.end.offset !== undefined && value)
      out.push({ from: p.start.offset, to: p.end.offset, value });
  };
  const walk = (node: Nodes) => {
    switch (node.type) {
      case 'yaml':
      case 'html':
      case 'embed':
        return;
      case 'text':
      case 'inlineCode':
      case 'code':
      case 'inlineMath':
      case 'math':
        return add(node, node.value);
      case 'wikiLink':
        return add(node, node.alias ?? node.target);
      case 'image':
        return add(node, node.alt ?? '');
      case 'tag':
        return add(node, node.name);
      default:
        if ('children' in node) for (const c of (node as Parent).children as Nodes[]) walk(c);
    }
  };
  walk(page.tree);
  out.sort((a, b) => a.from - b.from);
  leavesOf.set(page, out);
  return out;
}

/** The prose of the page, or of `from`–`to` in it (partly selected pieces
 *  as written). Pieces join without a space where only syntax parted them
 *  (`foo**bar**` is one word). */
export function proseOf(page: ParsedPage, text: string, from?: number, to?: number): string {
  let out = '';
  let prev = -1;
  for (const leaf of leaves(page)) {
    let value = leaf.value;
    let start = leaf.from;
    if (from !== undefined && to !== undefined) {
      if (leaf.to <= from || leaf.from >= to) continue;
      if (leaf.from < from || leaf.to > to) {
        start = Math.max(leaf.from, from);
        value = text.slice(start, Math.min(leaf.to, to));
      }
    }
    if (prev >= 0) out += /\s/.test(text.slice(prev, start)) || start < prev ? ' ' : '';
    out += value;
    prev = Math.max(prev, leaf.to);
  }
  return out;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const WORDISH = /[\p{L}\p{N}]/u;

export interface TextCount {
  words: number;
  /** Characters, runs of white space counted as one space. */
  chars: number;
  /** Characters without white space. */
  bare: number;
}

export function countText(prose: string): TextCount {
  const flat = prose.replace(/\s+/g, ' ').trim();
  const cjk = flat.match(CJK)?.length ?? 0;
  const words = flat
    .replace(CJK, ' ')
    .split(' ')
    .filter((w) => WORDISH.test(w)).length;
  const chars = [...flat].length;
  return { words: words + cjk, chars, bare: chars - (flat.match(/ /g)?.length ?? 0) };
}

export const readingMinutes = (words: number): number => Math.ceil(words / WORDS_PER_MINUTE);
