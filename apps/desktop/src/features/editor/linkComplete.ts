// `[[` / `![[` autocomplete (M2c §6): files from Rust's `link_suggest`
// (ranked there, with the shortest unique target), `#` headings parsed here.
// Picking a page whose title differs from its file name writes
// `[[file|Title]]`, so the link reads well and still resolves in Obsidian (PG-05).
import {
  acceptCompletion,
  autocompletion,
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSection,
} from '@codemirror/autocomplete';
import i18next from 'i18next';
import { Prec, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import type { Heading, RootContent } from 'mdast';
import { linkSuggest, linksResolve, pageRead, type LinkSuggestion } from '../../ipc';
import { headingLinkText } from '../../markdown/headings';
import { parsePage } from '../../markdown/parse';
import { text as nodeText } from '../../markdown/section';
import { iconsOf } from '../icons/ItemIcon';
import { announce } from './announce';
import { useVaultStore } from '../../stores/vaultStore';
import { pagePath } from './livePreview';

export type LinkQuery =
  | { kind: 'file'; embed: boolean; query: string; from: number; closed: boolean }
  | {
      kind: 'heading';
      embed: boolean;
      page: string;
      query: string;
      from: number;
      closed: boolean;
    };

/** `[[` or `![[` and the text typed after it on this line (no `[`, `]`). */
const LINK_BEFORE = /(!?)\[\[([^[\]\n]*)$/;

/** The link being typed at `pos`, or `null` (aliases end the completion). */
export function linkQueryAt(state: EditorState, pos: number): LinkQuery | null {
  const line = state.doc.lineAt(pos);
  const m = LINK_BEFORE.exec(line.text.slice(0, pos - line.from));
  if (!m || m[2].includes('|')) return null;
  const inner = m[2];
  const embed = m[1] === '!';
  const closed = state.doc.sliceString(pos, pos + 2) === ']]';
  const hash = inner.indexOf('#');
  if (hash < 0) return { kind: 'file', embed, query: inner, from: pos - inner.length, closed };
  const query = inner.slice(hash + 1);
  return {
    kind: 'heading',
    embed,
    page: inner.slice(0, hash),
    query,
    from: pos - query.length,
    closed,
  };
}

const key = (s: string) => s.normalize('NFC').toLowerCase();
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** PG-05: the title as an alias when it differs from the file name. */
export function aliasFor(s: LinkSuggestion): string | null {
  if (s.kind !== 'page' || !s.title) return null;
  const stem = baseName(s.path).replace(/\.md$/i, '');
  if (key(s.title) === key(stem)) return null;
  const alias = s.title.replace(/[[\]\n]/g, ' ').trim();
  return alias || null;
}

/** Inserts `text` over the query, then `]]` (or steps over an existing one). */
function applyText(text: string, closed: boolean) {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    const insert = closed ? text : `${text}]]`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length + (closed ? 2 : 0) },
      annotations: pickedCompletion.of(completion),
      userEvent: 'input.complete',
    });
  };
}

/** A file option: its emoji (M5b §4), if any, shows in a leading box. */
interface FileCompletion extends Completion {
  icon?: string;
}

function fileOption(s: LinkSuggestion, q: LinkQuery): FileCompletion {
  const alias = q.embed ? null : aliasFor(s);
  const label = s.title ?? baseName(s.path);
  return {
    label,
    icon: iconsOf(useVaultStore.getState().nodes).get(s.path),
    detail: s.path,
    type: s.kind === 'page' ? 'text' : 'variable',
    apply: applyText(alias ? `${s.target}|${alias}` : s.target, q.closed),
  };
}

interface HeadingItem {
  text: string;
  depth: number;
}

function headingsIn(source: string): HeadingItem[] {
  const out: HeadingItem[] = [];
  const walk = (nodes: RootContent[]) => {
    for (const n of nodes) {
      if (n.type === 'heading') {
        const text = nodeText(n).trim();
        if (text) out.push({ text, depth: (n as Heading).depth });
      } else if ('children' in n) walk(n.children as RootContent[]);
    }
  };
  walk(parsePage(source).tree.children);
  return out;
}

/** Another page's text for `#` completion, cached briefly per target. */
const pageCache = new Map<string, { at: number; text: Promise<string | null> }>();
const PAGE_CACHE_MS = 5000;

function pageText(path: string): Promise<string | null> {
  const hit = pageCache.get(path);
  if (hit && Date.now() - hit.at < PAGE_CACHE_MS) return hit.text;
  const text = pageRead(path).then((res) => (res.ok ? res.value.text : null));
  pageCache.set(path, { at: Date.now(), text });
  return text;
}

async function headingsFor(
  q: Extract<LinkQuery, { kind: 'heading' }>,
  state: EditorState,
  source: string,
): Promise<HeadingItem[]> {
  if (!q.page.trim()) return headingsIn(state.doc.toString());
  const res = await linksResolve(source, [{ kind: q.embed ? 'embed' : 'wiki', target: q.page }]);
  const path = res.ok ? res.value[0] : null;
  if (!path) return [];
  const text = await pageText(path);
  return text === null ? [] : headingsIn(text);
}

/** A query waits this long for the next keystroke before asking Rust, so a
 *  word typed quickly costs one search (M4b §4). */
export const SUGGEST_DEBOUNCE_MS = 80;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SEARCH_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.2" stroke-linecap="round" aria-hidden="true">' +
  '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>';

/** The list's first line (M4b §4): what was typed, or a hint, and how many
 *  match; it stays at the top while the list scrolls. */
function searchSection(query: string, count: number): CompletionSection {
  const typed = query.trim();
  const matches = i18next.t('linkComplete.matches', { count });
  // Read out politely: the line itself is part of the list's visuals, hidden
  // from screen readers.
  announce(typed ? i18next.t('linkComplete.matchesFor', { count, query: typed }) : matches);
  return {
    name: 'search',
    header: () => {
      const line = document.createElement('div');
      line.className = 'cm-liber-search';
      line.setAttribute('aria-hidden', 'true');
      line.innerHTML = SEARCH_ICON;
      const what = document.createElement('span');
      what.className = 'cm-liber-search-text';
      what.textContent = typed
        ? i18next.t('linkComplete.search', { query: typed })
        : i18next.t('linkComplete.typeToFilter');
      const count_ = document.createElement('span');
      count_.className = 'cm-liber-search-count';
      count_.textContent = matches;
      line.append(what, count_);
      return line;
    },
  };
}

/** The completion source for `[[`, `![[` and `#` headings. */
export async function linkSource(context: CompletionContext): Promise<CompletionResult | null> {
  const q = linkQueryAt(context.state, context.pos);
  if (!q) return null;
  const source = context.state.facet(pagePath)();
  if (q.kind === 'file') {
    await pause(SUGGEST_DEBOUNCE_MS);
    if (context.aborted) return null;
    const res = await linkSuggest(source, q.query, q.embed);
    if (context.aborted || !res.ok) return null;
    const section = searchSection(q.query, res.value.length);
    return {
      from: q.from,
      options: res.value.map((s) => ({ ...fileOption(s, q), section })),
      filter: false,
    };
  }
  const headings = await headingsFor(q, context.state, source);
  if (context.aborted) return null;
  const needle = q.query.trim().toLowerCase();
  const found = headings.filter((h) => h.text.toLowerCase().includes(needle));
  const section = searchSection(q.query, found.length);
  return {
    from: q.from,
    filter: false,
    options: found.map((h) => ({
      label: h.text,
      detail: `H${h.depth}`,
      type: 'keyword',
      section,
      apply: applyText(headingLinkText(h.text), q.closed),
    })),
  };
}

// A scoped theme (not a base theme) with selectors more specific than
// @codemirror/autocomplete's own, which sets a monospace font on the list.
const theme = EditorView.theme({
  '.cm-tooltip.cm-tooltip-autocomplete': {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border-strong)',
    borderRadius: 'var(--radius-md)',
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.14)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-body)',
    fontSize: '13.5px',
    maxHeight: '16em',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    padding: '4px 10px',
    color: 'var(--color-text)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    background: 'var(--color-accent-soft)',
    color: 'var(--color-text-strong)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete .cm-liber-search': {
    position: 'sticky',
    top: '0',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '5px 10px',
    background: 'var(--color-surface-subtle)',
    borderBottom: '1px solid var(--color-border)',
    color: 'var(--color-text-muted)',
    fontSize: '12.5px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete .cm-liber-search-text': {
    color: 'var(--color-text)',
    fontWeight: '600',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  '.cm-tooltip.cm-tooltip-autocomplete .cm-liber-search-count': {
    marginLeft: 'auto',
    flex: 'none',
  },
  '.cm-tooltip.cm-tooltip-autocomplete .cm-liber-linkIcon': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '18px',
    marginRight: '6px',
    verticalAlign: 'middle',
    color: 'var(--color-text-muted)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete .cm-completionDetail': {
    marginLeft: '10px',
    fontStyle: 'normal',
    color: 'var(--color-text-muted)',
  },
});

const SVG = 'http://www.w3.org/2000/svg';
/** Round 3b §8.2: an option's icon box: the page's emoji, else the page or
 *  file glyph (the explorer's). Headings get none. */
function iconBox(c: FileCompletion): Node | null {
  if (c.type !== 'text' && c.type !== 'variable') return null;
  const box = document.createElement('span');
  box.className = 'cm-liber-linkIcon';
  box.setAttribute('aria-hidden', 'true');
  if (c.icon) {
    box.textContent = c.icon;
    return box;
  }
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({
    width: '14',
    height: '14',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linejoin': 'round',
  }))
    svg.setAttribute(k, v);
  const shape =
    c.type === 'text' ? ['M6 3h8l4 4v14H6z'] : ['M4 4h16v16H4z', 'M4 16l5-5 4 4 3-3 4 4'];
  for (const d of shape) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  box.appendChild(svg);
  return box;
}

/** `[[` autocomplete for every editor mode; Tab accepts like Enter. */
export function linkCompletion(): Extension {
  return [
    autocompletion({
      override: [linkSource],
      icons: false,
      activateOnTyping: true,
      addToOptions: [{ render: iconBox, position: 20 }],
    }),
    Prec.highest(keymap.of([{ key: 'Tab', run: acceptCompletion }])),
    theme,
  ];
}
