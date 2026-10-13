// Block-level extensions (M2a spec §2.1): callouts, columns, comments.
import type { Blockquote, Paragraph, Parent, Root, RootContent, Text } from 'mdast';
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

const CALLOUT = /^\[!([A-Za-z][\w-]*)\]([+-]?)[ \t]*([^\n]*)/;

function toCallout(quote: Blockquote, src: string): Callout | null {
  const first = quote.children[0];
  if (!first || first.type !== 'paragraph') return null;
  const head = first.children[0];
  if (!head || head.type !== 'text') return null;
  const start = head.position!.start.offset!;
  const raw = src.slice(start, head.position!.end.offset!);
  const m = CALLOUT.exec(raw);
  if (!m) return null;
  const type = m[1].toLowerCase();
  const title = m[3].trim() || type.charAt(0).toUpperCase() + type.slice(1);
  // Drop the marker line from the first paragraph.
  const nl = head.value.indexOf('\n');
  const children = [...quote.children];
  const rest = nl >= 0 ? head.value.slice(nl + 1) : '';
  const firstChildren = [...first.children.slice(1)];
  if (rest) {
    const restStart = start + raw.indexOf('\n') + 1;
    firstChildren.unshift({
      type: 'text',
      value: rest,
      position: { start: { ...head.position!.end, offset: restStart }, end: head.position!.end },
    } as Text);
  } else if (firstChildren[0]?.type === 'break') {
    firstChildren.shift();
  }
  if (firstChildren.length) children[0] = { ...first, children: firstChildren } as Paragraph;
  else children.shift();
  return {
    type: 'callout',
    calloutType: type,
    title,
    foldable: m[2] !== '',
    folded: m[2] === '-',
    children: children as Callout['children'],
    position: quote.position,
  };
}

/** Source-text paragraph for a directive we don't support (shown as written). */
function asText(node: RootContent, src: string, loc: ReturnType<typeof locator>): Paragraph {
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
        const callout = toCallout(c, src);
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
