// Block-level extensions (M2a spec §2.1): callouts, columns, comments.
import type {
  Blockquote,
  Paragraph,
  Parent,
  PhrasingContent,
  Root,
  RootContent,
  Text,
} from 'mdast';
import type { ContainerDirective, LeafDirective } from 'mdast-util-directive';
import { directiveFromMarkdown } from 'mdast-util-directive';
import { directive } from 'micromark-extension-directive';
import type { Processor } from 'unified';
import type { locator } from './locate';
import type { Callout, Column, Columns } from './types';

/** Container (and leaf) directives only: the text form `:name` would turn
 * ordinary text such as `3:2` or `note:hello` into directives. */
export function remarkContainerDirectives(this: Processor) {
  const data = this.data() as {
    micromarkExtensions?: unknown[];
    fromMarkdownExtensions?: unknown[];
  };
  (data.micromarkExtensions ??= []).push({ flow: directive().flow });
  (data.fromMarkdownExtensions ??= []).push(directiveFromMarkdown());
}

const CALLOUT = /^\[!([A-Za-z][\w-]*)\]([+-]?)[ \t]*/;

type Locator = ReturnType<typeof locator>;

/** Plain text of inline nodes (before our inline transforms run). */
const plainText = (nodes: PhrasingContent[]): string =>
  nodes
    .map((n) =>
      'value' in n
        ? String(n.value)
        : 'children' in n
          ? plainText(n.children as PhrasingContent[])
          : '',
    )
    .join('');

/** `node` cut to `value[from, to)` / source `[start, end)`. */
function textPart(
  node: Text,
  from: number,
  to: number,
  start: number,
  end: number,
  loc: Locator,
): Text {
  return { type: 'text', value: node.value.slice(from, to), position: loc.position(start, end) };
}

/**
 * Splits a callout's first paragraph at the end of its first line: the
 * title's inline nodes (marker dropped), and the rest of the paragraph.
 */
function splitTitle(
  first: Paragraph,
  src: string,
  loc: Locator,
): { title: PhrasingContent[]; rest: PhrasingContent[] } | null {
  const head = first.children[0];
  if (!head || head.type !== 'text') return null;
  const start = head.position!.start.offset!;
  const inSrc = CALLOUT.exec(src.slice(start, head.position!.end.offset!));
  const inValue = CALLOUT.exec(head.value);
  // The marker has no escapes; only the spaces after it can differ (the value
  // drops them before a line ending).
  if (!inSrc || !inValue || inSrc[0].trimEnd() !== inValue[0].trimEnd()) return null;
  const kids: PhrasingContent[] = [
    textPart(
      head,
      inValue[0].length,
      head.value.length,
      start + inSrc[0].length,
      head.position!.end.offset!,
      loc,
    ),
    ...first.children.slice(1),
  ];
  for (let k = 0; k < kids.length; k++) {
    const n = kids[k];
    if (n.type === 'break') return { title: kids.slice(0, k), rest: kids.slice(k + 1) };
    if (n.type !== 'text' || !n.value.includes('\n')) continue;
    const s = n.position!.start.offset!;
    const e = n.position!.end.offset!;
    const nl = n.value.indexOf('\n');
    const srcNl = src.indexOf('\n', s);
    if (srcNl < 0 || srcNl >= e) return null;
    const before = textPart(n, 0, nl, s, srcNl, loc);
    const after = textPart(n, nl + 1, n.value.length, srcNl + 1, e, loc);
    return {
      title: [...kids.slice(0, k), ...(before.value ? [before] : [])],
      rest: [...(after.value ? [after] : []), ...kids.slice(k + 1)],
    };
  }
  return { title: kids, rest: [] };
}

function toCallout(quote: Blockquote, src: string, loc: Locator): Callout | null {
  const first = quote.children[0];
  if (!first || first.type !== 'paragraph') return null;
  const head = first.children[0];
  if (!head || head.type !== 'text') return null;
  const m = /^\[!([A-Za-z][\w-]*)\]([+-]?)/.exec(head.value);
  const parts = m && splitTitle(first, src, loc);
  if (!m || !parts) return null;
  const type = m[1].toLowerCase();
  // Whitespace-only text at the edges of the title isn't content.
  const title = parts.title.filter(
    (n, i, all) => !(n.type === 'text' && !n.value.trim() && (i === 0 || i === all.length - 1)),
  );
  const children = [...quote.children] as Callout['children'];
  if (parts.rest.length) children[0] = { ...first, children: parts.rest } as Paragraph;
  else children.shift();
  if (title.length) {
    const s = title[0].position!.start.offset!;
    const e = title.at(-1)!.position!.end.offset!;
    children.unshift({ type: 'calloutTitle', children: title, position: loc.position(s, e) });
  }
  return {
    type: 'callout',
    calloutType: type,
    title: plainText(title).trim() || type.charAt(0).toUpperCase() + type.slice(1),
    foldable: m[2] !== '',
    folded: m[2] === '-',
    children,
    position: quote.position,
  };
}

/** Source-text paragraph for a directive we don't support (shown as written). */
function asText(node: RootContent, src: string, loc: Locator): Paragraph {
  const s = node.position!.start.offset!;
  const e = node.position!.end.offset!;
  return {
    type: 'paragraph',
    children: [{ type: 'text', value: src.slice(s, e), position: loc.position(s, e) }],
    position: loc.position(s, e),
  };
}

function toColumns(node: ContainerDirective): Columns {
  const columns: Column[] = [];
  for (const child of node.children) {
    if (child.type === 'containerDirective' && child.name === 'column') {
      columns.push({
        type: 'column',
        children: child.children as Column['children'],
        position: child.position,
      });
    } else if (child.type !== 'paragraph' || child.data?.directiveLabel !== true) {
      // Content outside any :::column goes into its own column.
      columns.push({
        type: 'column',
        children: [child as Column['children'][number]],
        position: child.position,
      });
    }
  }
  return { type: 'columns', children: columns, position: node.position };
}

/** Callouts, columns, and unsupported directives back to text. */
export function transformBlocks(tree: Root, src: string, loc: ReturnType<typeof locator>) {
  const walk = (parent: Parent) => {
    parent.children = parent.children.map((child) => {
      const c = child as RootContent;
      if (c.type === 'blockquote') {
        const callout = toCallout(c, src, loc);
        if (callout) {
          walk(callout);
          return callout;
        }
      }
      if (c.type === 'containerDirective') {
        if (c.name === 'columns') {
          const cols = toColumns(c);
          for (const col of cols.children) walk(col);
          return cols;
        }
        return asText(c, src, loc);
      }
      if (c.type === 'leafDirective') return asText(c as LeafDirective, src, loc);
      if ('children' in c) walk(c as Parent);
      return c;
    }) as typeof parent.children;
  };
  walk(tree);
}

/** Offsets of code (fenced, indented, inline) in a tree, to keep `%%` there literal. */
function codeRanges(tree: Root): [number, number][] {
  const out: [number, number][] = [];
  const walk = (n: RootContent | Root) => {
    if (n.type === 'code' || n.type === 'inlineCode' || n.type === 'yaml' || n.type === 'html') {
      out.push([n.position!.start.offset!, n.position!.end.offset!]);
      return;
    }
    if ('children' in n) for (const c of (n as Parent).children) walk(c as RootContent);
  };
  walk(tree);
  return out;
}

/** `%% … %%` ranges outside code; an unclosed `%%` is not a comment. */
export function findComments(src: string, tree: Root): [number, number][] {
  if (!src.includes('%%')) return [];
  const code = codeRanges(tree);
  const inCode = (i: number) => code.some(([s, e]) => i >= s && i < e);
  const out: [number, number][] = [];
  let i = src.indexOf('%%');
  while (i >= 0) {
    if (inCode(i)) {
      i = src.indexOf('%%', i + 2);
      continue;
    }
    let close = src.indexOf('%%', i + 2);
    while (close >= 0 && inCode(close)) close = src.indexOf('%%', close + 2);
    if (close < 0) break;
    out.push([i, close + 2]);
    i = src.indexOf('%%', close + 2);
  }
  return out;
}

/** Same length as `src`, with comments blanked (newlines kept) so every
 * position in the parsed tree still indexes the original text. */
export function maskComments(src: string, comments: [number, number][]): string {
  if (!comments.length) return src;
  let out = '';
  let last = 0;
  for (const [s, e] of comments) {
    out += src.slice(last, s) + src.slice(s, e).replace(/[^\r\n]/g, ' ');
    last = e;
  }
  return out + src.slice(last);
}
