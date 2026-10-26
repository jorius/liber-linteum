// Safe render tree (M2a spec §2.4): mdast → hast with our extension nodes,
// raw HTML parsed in place, then sanitized with an allowlist and the URL
// policy (vault paths → asset paths, remote media → placeholders). Uses
// hast-util-sanitize rather than DOMPurify so source positions survive
// (scroll sync in Split, block dragging in M4).
import GithubSlugger from 'github-slugger';
import type { Element, ElementContent, Nodes, Properties, Root } from 'hast';
import { raw } from 'hast-util-raw';
import { sanitize, type Schema } from 'hast-util-sanitize';
import type { Image as MdImage, Nodes as MdastNodes } from 'mdast';
import { defaultHandlers, toHast, type Handler, type State } from 'mdast-util-to-hast';
import type {
  Callout,
  CalloutTitle,
  Column,
  Columns,
  Embed,
  Highlight,
  ParsedPage,
  Tag,
  WikiLink,
} from './types';
import { highlightCode } from './codeHighlight';
import { safeDecode } from './decode';
import { isFileTarget } from './externalPath';

/** Colors allowed in `data-color` / `data-bg` (theme-aware tokens). */
export const PALETTE = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'] as const;

export interface RenderContext {
  /** Vault path of the page being rendered (relative links resolve from its folder). */
  sourcePath: string;
}

/** Vault-relative join of a Markdown/HTML path from a page; `null` if it would
 * leave the vault or is empty. A leading `/` means the vault root. */
export function vaultJoin(sourcePath: string, target: string): string | null {
  const decoded = safeDecode(target);
  const fromRoot = decoded.startsWith('/');
  const base = fromRoot ? [] : sourcePath.split('/').slice(0, -1);
  const parts = [...base];
  for (const seg of decoded.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.length ? parts.join('/') : null;
}

const el = (tagName: string, properties: Properties, children: ElementContent[] = []): Element => ({
  type: 'element',
  tagName,
  properties,
  children,
});

const handlers: Record<string, Handler> = {
  wikiLink(state: State, node: WikiLink) {
    const label = node.alias ?? (node.heading ? `${node.target} › ${node.heading}` : node.target);
    const out = el(
      'a',
      { dataLiber: 'wikilink', dataTarget: node.target, dataHeading: node.heading ?? undefined },
      [{ type: 'text', value: label }],
    );
    state.patch(node, out);
    return out;
  },
  // 0.1.2: Obsidian's `![alt|300](x.png)` sizes a Markdown image as `|300`
  // sizes an embed; the alt keeps the rest.
  image(state: State, node: MdImage) {
    const out = defaultHandlers.image(state, node);
    const m = /^(.*?)\|\s*(\d+)(?:\s*x\s*(\d+))?\s*$/.exec(node.alt ?? '');
    if (m) {
      out.properties.alt = m[1];
      out.properties.width = Number(m[2]);
      if (m[3]) out.properties.height = Number(m[3]);
    }
    return out;
  },
  embed(state: State, node: Embed) {
    const out = el('span', {
      dataLiber: 'embed',
      dataTarget: node.target,
      dataHeading: node.heading ?? undefined,
      dataWidth: node.width ?? undefined,
      dataHeight: node.height ?? undefined,
    });
    state.patch(node, out);
    return out;
  },
  // M4b part 2 §3: maths become placeholders the renderer draws with KaTeX
  // after sanitizing (KaTeX's own markup would not pass the schema).
  inlineMath(state: State, node: { value: string }) {
    const out = el('span', { dataLiber: 'math', dataTex: node.value });
    state.patch(node as unknown as MdastNodes, out);
    return out;
  },
  math(state: State, node: { value: string }) {
    const out = el('div', { dataLiber: 'math', dataTex: node.value, dataDisplay: 'block' });
    state.patch(node as unknown as MdastNodes, out);
    return out;
  },
  highlight(state: State, node: Highlight) {
    const out = el('mark', {}, state.all(node as unknown as MdastNodes));
    state.patch(node, out);
    return out;
  },
  tag(state: State, node: Tag) {
    const out = el('span', { dataLiber: 'tag', dataTag: node.name }, [
      { type: 'text', value: `#${node.name}` },
    ]);
    state.patch(node, out);
    return out;
  },
  callout(state: State, node: Callout) {
    const out = el(
      'div',
      {
        dataLiber: 'callout',
        dataCallout: node.calloutType,
        dataTitle: node.title,
        dataFoldable: String(node.foldable),
        dataFolded: String(node.folded),
      },
      state.wrap(state.all(node as unknown as MdastNodes), true),
    );
    state.patch(node, out);
    return out;
  },
  calloutTitle(state: State, node: CalloutTitle) {
    const out = el('div', { dataLiber: 'callout-title' }, state.all(node as unknown as MdastNodes));
    state.patch(node, out);
    return out;
  },
  columns(state: State, node: Columns) {
    const out = el(
      'div',
      { dataLiber: 'columns' },
      state.wrap(state.all(node as unknown as MdastNodes), true),
    );
    state.patch(node, out);
    return out;
  },
  column(state: State, node: Column) {
    const out = el(
      'div',
      { dataLiber: 'column' },
      state.wrap(state.all(node as unknown as MdastNodes), true),
    );
    state.patch(node, out);
    return out;
  },
  yaml() {
    return undefined;
  },
} as unknown as Record<string, Handler>;

const BLOCK = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'table',
  'tr',
  'hr',
  'div',
]);

/** `data-source-start/end` on block elements that come from Markdown. */
function markSourceRanges(node: Nodes) {
  if (node.type === 'element' && BLOCK.has(node.tagName) && node.position) {
    node.properties.dataSourceStart = node.position.start.offset;
    node.properties.dataSourceEnd = node.position.end.offset;
  }
  if ('children' in node) for (const c of node.children) markSourceRanges(c as Nodes);
}

const DATA = ['dataLiber', 'dataSourceStart', 'dataSourceEnd'];
const schema: Schema = {
  strip: ['script', 'style'],
  clobber: [],
  clobberPrefix: '',
  ancestors: {},
  protocols: { href: ['http', 'https', 'mailto'], src: ['http', 'https', 'data'] },
  tagNames: [
    'a',
    'b',
    'strong',
    'i',
    'em',
    'u',
    's',
    'del',
    'ins',
    'mark',
    'sub',
    'sup',
    'kbd',
    'code',
    'pre',
    'br',
    'hr',
    'p',
    'span',
    'div',
    'blockquote',
    'ul',
    'ol',
    'li',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'details',
    'summary',
    'img',
    'audio',
    'video',
    'source',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'input',
    'section',
  ],
  attributes: {
    '*': [...DATA, 'title'],
    a: ['href', 'dataTarget', 'dataHeading', 'dataExternal'],
    span: [
      'dataColor',
      'dataBg',
      'dataTarget',
      'dataHeading',
      'dataWidth',
      'dataHeight',
      'dataTag',
      'dataTex',
      // Syntax highlighting (M4b part 2 §2): highlight.js classes only — its
      // scopes (`hljs-title`) and their sub-scopes (`class_`, `function_`;
      // final review M6).
      ['className', /^(?:hljs-[\w-]+|[a-z][a-z0-9]*_+)$/],
    ],
    div: [
      'dataColor',
      'dataBg',
      'dataCallout',
      'dataTitle',
      'dataFoldable',
      'dataFolded',
      'dataTex',
      'dataDisplay',
    ],
    img: ['src', 'alt', 'width', 'height', 'dataExternal'],
    audio: ['src', 'controls', 'dataExternal'],
    video: ['src', 'controls', 'width', 'height', 'dataExternal'],
    source: ['src', 'type', 'dataExternal'],
    details: ['open'],
    ol: ['start'],
    li: ['className'],
    ul: ['className'],
    code: ['className'],
    pre: ['dataLang'],
    td: ['align'],
    th: ['align'],
    input: [['type', 'checkbox'], 'checked', 'disabled'],
  },
  required: { input: { type: 'checkbox', disabled: true } },
};

const REMOTE = /^https?:/i;
const EXTERNAL = /^(https?|mailto):/i;
const MEDIA = new Set(['img', 'audio', 'video', 'source']);

function applyUrlPolicy(parent: Root | Element, ctx: RenderContext) {
  parent.children = parent.children.map((child) => {
    if (child.type !== 'element') return child;
    const p = child.properties;
    for (const key of ['dataColor', 'dataBg'] as const) {
      if (p[key] !== undefined && !(PALETTE as readonly string[]).includes(String(p[key]))) {
        delete p[key];
      }
    }
    if (child.tagName === 'a' && p.dataLiber !== 'wikilink' && typeof p.href === 'string') {
      const href = p.href;
      if (EXTERNAL.test(href)) {
        p.dataLiber = 'external';
      } else if (href.startsWith('#')) {
        p.dataLiber = 'anchor';
      } else {
        const hash = href.indexOf('#');
        const path = hash >= 0 ? href.slice(0, hash) : href;
        const target = path && !isFileTarget(path) ? vaultJoin(ctx.sourcePath, path) : null;
        p.dataLiber = 'link';
        if (target) p.dataTarget = target;
        if (hash >= 0 && href.slice(hash + 1)) p.dataHeading = safeDecode(href.slice(hash + 1));
        delete p.href;
      }
    }
    if (MEDIA.has(child.tagName) && typeof p.src === 'string') {
      const src = p.src;
      if (REMOTE.test(src)) {
        return {
          type: 'element',
          tagName: 'span',
          properties: { dataLiber: 'remote-blocked', dataUrl: src },
          children: [{ type: 'text', value: typeof p.alt === 'string' && p.alt ? p.alt : src }],
          position: child.position,
        } satisfies Element;
      }
      if (/^data:image\//i.test(src) && child.tagName === 'img') {
        // inline image data: allowed by the CSP, no request
      } else if (/^[a-z][a-z0-9+.-]*:/i.test(src)) {
        delete p.src;
      } else {
        const path = vaultJoin(ctx.sourcePath, src);
        delete p.src;
        if (path) p.dataAssetPath = path;
        else if (p.dataExternal === undefined) p.dataLiber = 'missing';
      }
    }
    applyUrlPolicy(child, ctx);
    return child;
  });
}

function textOf(n: ElementContent): string {
  if (n.type === 'text') return n.value;
  if (n.type === 'element') return n.children.map(textOf).join('');
  return '';
}

function addHeadingIds(tree: Root) {
  const slugger = new GithubSlugger();
  const walk = (n: Root | Element) => {
    for (const c of n.children) {
      if (c.type !== 'element') continue;
      if (/^h[1-6]$/.test(c.tagName)) c.properties.id = slugger.slug(textOf(c));
      walk(c);
    }
  };
  walk(tree);
}

/** The source ranges of the HTML blocks (raw at the top level), in order. */
function htmlBlocks(root: Root): [number, number][] {
  const out: [number, number][] = [];
  for (const c of root.children) {
    const at = c.position;
    if (c.type === 'raw' && at?.start.offset !== undefined && at.end.offset !== undefined) {
      out.push([at.start.offset, at.end.offset]);
    }
  }
  return out;
}

/** Gives the first element each HTML block renders its block's source range:
 *  the block gutter's anchor (M4 §4). The elements are left where the HTML
 *  put them — a `<details>` opened in one block still holds the Markdown
 *  blocks after it (final review I1). A block that renders no element (a
 *  comment, a closing tag) has no anchor. */
function markHtmlBlocks(root: Root, blocks: [number, number][]) {
  if (!blocks.length) return;
  const marked = new Set<number>();
  /** The block whose range holds `at` (binary search: blocks are sorted). */
  const blockAt = (at: number) => {
    let lo = 0;
    let hi = blocks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid][1] <= at) lo = mid + 1;
      else if (blocks[mid][0] > at) hi = mid - 1;
      else return mid;
    }
    return -1;
  };
  const walk = (n: Root | Element) => {
    for (const c of n.children) {
      if (c.type !== 'element') continue;
      const at = c.position?.start.offset;
      const k = at === undefined || c.properties.dataSourceStart !== undefined ? -1 : blockAt(at);
      if (k >= 0 && !marked.has(k)) {
        marked.add(k);
        c.properties.dataSourceStart = blocks[k][0];
        c.properties.dataSourceEnd = blocks[k][1];
      }
      walk(c);
    }
  };
  walk(root);
}

/** What `raw` needs to keep source positions on the elements it parses from
 *  HTML (it reads the file only for the root's own position). */
const POSITIONS = { file: { toString: () => '' } } as unknown as Parameters<typeof raw>[1];

const LINKED = new Set(['a', 'img', 'audio', 'video', 'source']);

/** A per-render secret prefixed to every `data-external` the pipeline sets
 *  (final review C1/m2): raw HTML may carry its own `data-external`, which the
 *  schema has to let through for ours, so after sanitizing only sealed values
 *  are kept (unsealed) and any other is dropped. */
function newSeal(): string {
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  return `liber${bytes[0].toString(36)}${bytes[1].toString(36)}:`;
}

/** Keeps the pipeline's own `data-external` values (without their seal) and
 *  drops any raw HTML wrote. */
function unsealExternal(node: Root | Element, seal: string) {
  for (const c of node.children) {
    if (c.type !== 'element') continue;
    const value = c.properties.dataExternal;
    if (value !== undefined) {
      if (typeof value === 'string' && value.startsWith(seal)) {
        c.properties.dataExternal = value.slice(seal.length);
      } else {
        delete c.properties.dataExternal;
      }
    }
    unsealExternal(c, seal);
  }
}

/** Markdown links and images that may name a file outside the vault (M4b
 *  part 3 §9) get `data-external` (sealed with `seal`): the target as the
 *  index reads it (%-decoded, no `#…`). File targets lose their `src`/`href`,
 *  which the URL policy would drop; a leading `/` keeps it (the vault root
 *  comes first). Runs before raw HTML is parsed, and raw HTML's own
 *  `data-external` is dropped after (`unsealExternal`), so raw HTML never
 *  reaches outside files (the index doesn't see its links either). */
function markExternal(node: Nodes, ctx: RenderContext, seal: string) {
  if (node.type === 'element' && LINKED.has(node.tagName)) {
    const p = node.properties;
    const key = node.tagName === 'a' ? 'href' : 'src';
    const value = typeof p[key] === 'string' ? (p[key] as string) : null;
    const path = value === null ? '' : safeDecode(value.split('#')[0]);
    if (value !== null && path && !/^(https?|mailto|data):/i.test(value)) {
      if (isFileTarget(path)) {
        p.dataExternal = seal + path;
        delete p[key];
        if (node.tagName === 'a') p.dataLiber = 'link';
      } else if (path.startsWith('/') || vaultJoin(ctx.sourcePath, value) === null) {
        p.dataExternal = seal + path;
      }
    }
  }
  if ('children' in node) for (const c of node.children) markExternal(c as Nodes, ctx, seal);
}

/** The page as a sanitized hast tree, ready for React rendering. */
export function toSafeHast(page: ParsedPage, ctx: RenderContext): Root {
  const hast = toHast(page.tree, { allowDangerousHtml: true, handlers }) as Root;
  markSourceRanges(hast);
  const seal = newSeal();
  markExternal(hast, ctx, seal);
  highlightCode(hast);
  const blocks = htmlBlocks(hast);
  const parsed = raw(hast, POSITIONS) as Root;
  const clean = sanitize(parsed, schema) as Root;
  unsealExternal(clean, seal);
  applyUrlPolicy(clean, ctx);
  markHtmlBlocks(clean, blocks);
  addHeadingIds(clean);
  return clean;
}
