// Incremental re-parse for typing (M2a §7: a keystroke in a 5,000-line note
// re-parses in < 50 ms; a full remark parse of such a note takes ~110 ms).
// Only the top-level blocks around the edit are parsed again; everything with
// a reach beyond its own block falls back to a full parse.
import type { Node, Parent, Root, RootContent } from 'mdast';
import { finishPage, parsePage, parseTree } from './parse';
import type { ParsedPage } from './types';

/** Constructs whose meaning can depend on, or change, text outside their own
 *  block: fences, HTML, comments, definitions/footnotes, directives, math. */
const NONLOCAL = /`{3}|~{3}|%%|\]:|<|^[ \t]*:{3}|\$\$/m;

/** Nodes whose children are blocks (where a definition can stand). */
const FLOW = new Set([
  'root',
  'blockquote',
  'list',
  'listItem',
  'callout',
  'columns',
  'column',
  'footnoteDefinition',
]);

/** Whether the tree holds a link/image definition or a footnote definition. */
function hasDefinitions(node: Node): boolean {
  if (node.type === 'definition' || node.type === 'footnoteDefinition') return true;
  if (!FLOW.has(node.type)) return false;
  return ((node as Parent).children as Node[]).some(hasDefinitions);
}

const begin = (n: Node) => n.position!.start.offset!;
const end = (n: Node) => n.position!.end.offset!;

/** Line-start offset at or before `pos`. */
const lineStart = (text: string, pos: number) => text.lastIndexOf('\n', pos - 1) + 1;

/** `pos` is a line start preceded by a blank line (or the start of the text). */
function blankBefore(text: string, pos: number): boolean {
  if (pos === 0) return true;
  const prev = text.lastIndexOf('\n', pos - 2);
  return text.slice(prev + 1, pos - 1).trim() === '';
}

/** After `pos` comes the end of its line, a blank line, then a line that
 *  isn't indented (so it can't continue a list or a code block) — or nothing. */
function blankAfter(text: string, pos: number): boolean {
  const m = /^[ \t]*(?:\n|$)/.exec(text.slice(pos, pos + 200));
  if (!m) return false;
  const rest = text.slice(pos + m[0].length);
  if (!rest) return true;
  const blank = /^[ \t]*\n/.exec(rest);
  if (!blank) return false;
  const after = rest.slice(blank[0].length).replace(/^([ \t]*\n)+/, '');
  return after === '' || !/^[ \t]/.test(after);
}

/** Moves every position in `nodes` by `offset` characters and `lines` lines. */
function shift(nodes: Node[], offset: number, lines: number) {
  const walk = (n: Node) => {
    const p = n.position;
    if (p) {
      p.start = { ...p.start, offset: p.start.offset! + offset, line: p.start.line + lines };
      p.end = { ...p.end, offset: p.end.offset! + offset, line: p.end.line + lines };
    }
    const children = (n as Parent).children as Node[] | undefined;
    if (children) children.forEach(walk);
  };
  nodes.forEach(walk);
}

const countLines = (text: string, from: number, to: number) => {
  let n = 0;
  for (let i = from; i < to; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

/** The model of `text`, reusing `prev` (the model of `prevText`). Takes
 *  ownership of `prev`: its nodes are reused and moved, so don't use it again. */
export function reparse(prev: ParsedPage, prevText: string, text: string): ParsedPage {
  if (text === prevText) return prev;
  const blocks = prev.tree.children;
  // Frontmatter stays a fixed first block as long as the edit is past its end.
  const fixed = blocks[0]?.type === 'yaml' ? 1 : 0;
  if (blocks.length - fixed < 3 || (!fixed && text.startsWith('---'))) return parsePage(text);
  // The changed region: [from, oldTo) in prevText became [from, newTo) in text.
  let from = 0;
  const max = Math.min(prevText.length, text.length);
  while (from < max && prevText.charCodeAt(from) === text.charCodeAt(from)) from++;
  let oldTo = prevText.length;
  let newTo = text.length;
  while (
    oldTo > from &&
    newTo > from &&
    prevText.charCodeAt(oldTo - 1) === text.charCodeAt(newTo - 1)
  ) {
    oldTo--;
    newTo--;
  }
  // Blocks touching the change, widened by one neighbour on each side.
  let first = blocks.findIndex((b) => end(b) >= from);
  let last = blocks.length - 1;
  while (last > 0 && begin(blocks[last]) > oldTo) last--;
  if (first < fixed || last < first) return parsePage(text);
  first = Math.max(fixed, first - 1);
  last = Math.min(blocks.length - 1, last + 1);
  const sliceStart = lineStart(prevText, begin(blocks[first]));
  const oldEnd = end(blocks[last]);
  if (from < sliceStart || oldTo > oldEnd) return parsePage(text);
  // A comment reaching into the slice: its masking and pairing need the whole page.
  if (prev.comments.some(([s, e]) => s < oldEnd && e > sliceStart)) return parsePage(text);
  const delta = text.length - prevText.length;
  const newEnd = oldEnd + delta;
  const slice = text.slice(sliceStart, newEnd);
  // Right after the frontmatter's closing fence a new block always starts.
  const afterFrontmatter = fixed === 1 && first === 1 && sliceStart === end(blocks[0]) + 1;
  if (
    (!afterFrontmatter && !blankBefore(text, sliceStart)) ||
    !blankAfter(text, newEnd) ||
    NONLOCAL.test(slice) ||
    NONLOCAL.test(prevText.slice(sliceStart, oldEnd)) ||
    // `[ref]` / `[^1]` resolve against definitions elsewhere on the page.
    (slice.includes('[') && hasDefinitions(prev.tree))
  ) {
    return parsePage(text);
  }
  // A slice past the page's start can't hold front matter: a `---` first
  // in it is a rule (final review C2).
  const part = parseTree(slice, undefined, sliceStart === 0).children;
  const before = blocks.slice(0, first);
  const after = blocks.slice(last + 1);
  // Lists separated only by blank lines merge: let the full parse decide.
  const edgeList = (a?: RootContent, b?: RootContent) => a?.type === 'list' && b?.type === 'list';
  if (
    !part.length ||
    part.some((n) => n.type === 'yaml') ||
    edgeList(before.at(-1), part[0]) ||
    edgeList(part.at(-1), after[0])
  ) {
    return parsePage(text);
  }
  shift(part, sliceStart, countLines(text, 0, sliceStart));
  shift(
    after,
    delta,
    countLines(text, sliceStart, newEnd) - countLines(prevText, sliceStart, oldEnd),
  );
  const lines = countLines(text, 0, text.length);
  const tree: Root = {
    ...prev.tree,
    children: [...before, ...part, ...after],
    position: {
      start: { line: 1, column: 1, offset: 0 },
      end: {
        line: lines + 1,
        column: text.length - (text.lastIndexOf('\n') + 1) + 1,
        offset: text.length,
      },
    },
  };
  const comments = prev.comments.map(([s, e]): [number, number] =>
    s >= oldEnd ? [s + delta, e + delta] : [s, e],
  );
  return finishPage(tree, comments);
}
