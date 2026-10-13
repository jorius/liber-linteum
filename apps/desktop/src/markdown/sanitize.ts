// Safe render tree (M2a spec §2.4): mdast → hast with our extension nodes,
// raw HTML parsed in place, then sanitized with an allowlist and the URL
// policy (vault paths → asset paths, remote media → placeholders). Uses
// hast-util-sanitize rather than DOMPurify so source positions survive
// (scroll sync in Split, block dragging in M4).
import GithubSlugger from 'github-slugger';
import type { Element, ElementContent, Nodes, Properties, Root } from 'hast';
import { raw } from 'hast-util-raw';
import { sanitize, type Schema } from 'hast-util-sanitize';
import type { Nodes as MdastNodes } from 'mdast';
import { toHast, type Handler, type State } from 'mdast-util-to-hast';
import type {
  Callout,
  Column,
  Columns,
  Embed,
  Highlight,
  ParsedPage,
  Tag,
  WikiLink,
} from './types';

/** Colors allowed in `data-color` / `data-bg` (theme-aware tokens). */
export const PALETTE = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'] as const;

export interface RenderContext {
  /** Vault path of the page being rendered (relative links resolve from its folder). */
  sourcePath: string;
}

/** Vault-relative join of a Markdown/HTML path from a page; `null` if it would
 * leave the vault or is empty. A leading `/` means the vault root. */
export function vaultJoin(sourcePath: string, target: string): string | null {
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    // keep as written
  }
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
      { dataNimw: 'wikilink', dataTarget: node.target, dataHeading: node.heading ?? undefined },
      [{ type: 'text', value: label }],
    );
    state.patch(node, out);
    return out;
  },
  embed(state: State, node: Embed) {
    const out = el('span', {
      dataNimw: 'embed',
      dataTarget: node.target,
      dataHeading: node.heading ?? undefined,
      dataWidth: node.width ?? undefined,
      dataHeight: node.height ?? undefined,
    });
    state.patch(node, out);
    return out;
  },
  highlight(state: State, node: Highlight) {
    const out = el('mark', {}, state.all(node as unknown as MdastNodes));
    state.patch(node, out);
    return out;
  },
  tag(state: State, node: Tag) {
    const out = el('span', { dataNimw: 'tag', dataTag: node.name }, [
      { type: 'text', value: `#${node.name}` },
    ]);
    state.patch(node, out);
    return out;
  },
  callout(state: State, node: Callout) {
    const out = el(
      'div',
      {
        dataNimw: 'callout',
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
  columns(state: State, node: Columns) {
    const out = el(
      'div',
      { dataNimw: 'columns' },
      state.wrap(state.all(node as unknown as MdastNodes), true),
    );
    state.patch(node, out);
    return out;
  },
  column(state: State, node: Column) {
    const out = el(
      'div',
      { dataNimw: 'column' },
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

const DATA = ['dataNimw', 'dataSourceStart', 'dataSourceEnd'];
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
    a: ['href', 'dataTarget', 'dataHeading'],
    span: [
      'dataColor',
      'dataBg',
      'dataTarget',
      'dataHeading',
      'dataWidth',
      'dataHeight',
      'dataTag',
    ],
    div: ['dataColor', 'dataBg', 'dataCallout', 'dataTitle', 'dataFoldable', 'dataFolded'],
    img: ['src', 'alt', 'width', 'height'],
    audio: ['src', 'controls'],
    video: ['src', 'controls', 'width', 'height'],
    source: ['src', 'type'],
    details: ['open'],
    ol: ['start'],
    li: ['className'],
    ul: ['className'],
    code: ['className'],
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
    if (child.tagName === 'a' && p.dataNimw !== 'wikilink' && typeof p.href === 'string') {
      const href = p.href;
      if (EXTERNAL.test(href)) {
        p.dataNimw = 'external';
      } else if (href.startsWith('#')) {
        p.dataNimw = 'anchor';
      } else {
        const hash = href.indexOf('#');
        const path = hash >= 0 ? href.slice(0, hash) : href;
        const target = path ? vaultJoin(ctx.sourcePath, path) : null;
        p.dataNimw = 'link';
        if (target) p.dataTarget = target;
        if (hash >= 0 && href.slice(hash + 1))
          p.dataHeading = decodeURIComponent(href.slice(hash + 1));
        delete p.href;
      }
    }
    if (MEDIA.has(child.tagName) && typeof p.src === 'string') {
      const src = p.src;
      if (REMOTE.test(src)) {
        return {
          type: 'element',
          tagName: 'span',
          properties: { dataNimw: 'remote-blocked', dataUrl: src },
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
        else p.dataNimw = 'missing';
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

/** The page as a sanitized hast tree, ready for React rendering. */
export function toSafeHast(page: ParsedPage, ctx: RenderContext): Root {
  const hast = toHast(page.tree, { allowDangerousHtml: true, handlers }) as Root;
  markSourceRanges(hast);
  const parsed = raw(hast) as Root;
  const clean = sanitize(parsed, schema) as Root;
  applyUrlPolicy(clean, ctx);
  addHeadingIds(clean);
  return clean;
}
