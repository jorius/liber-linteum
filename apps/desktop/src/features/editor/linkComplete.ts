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
} from '@codemirror/autocomplete';
import { Prec, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import type { Heading, RootContent } from 'mdast';
import { linkSuggest, linksResolve, pageRead, type LinkSuggestion } from '../../ipc';
import { headingLinkText } from '../../markdown/headings';
import { parsePage } from '../../markdown/parse';
import { text as nodeText } from '../../markdown/section';
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
function aliasFor(s: LinkSuggestion): string | null {
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

function fileOption(s: LinkSuggestion, q: LinkQuery): Completion {
  const alias = q.embed ? null : aliasFor(s);
  return {
    label: s.title ?? baseName(s.path),
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

/** The completion source for `[[`, `![[` and `#` headings. */
export async function linkSource(context: CompletionContext): Promise<CompletionResult | null> {
  const q = linkQueryAt(context.state, context.pos);
  if (!q) return null;
  const source = context.state.facet(pagePath)();
  if (q.kind === 'file') {
    const res = await linkSuggest(source, q.query, q.embed);
    if (context.aborted || !res.ok) return null;
    return { from: q.from, options: res.value.map((s) => fileOption(s, q)), filter: false };
  }
  const headings = await headingsFor(q, context.state, source);
  if (context.aborted) return null;
  const needle = q.query.trim().toLowerCase();
  return {
    from: q.from,
    filter: false,
    options: headings
      .filter((h) => h.text.toLowerCase().includes(needle))
      .map((h) => ({
        label: h.text,
        detail: `H${h.depth}`,
        type: 'keyword',
        apply: applyText(headingLinkText(h.text), q.closed),
      })),
  };
}

const theme = EditorView.baseTheme({
  '.cm-tooltip.cm-tooltip-autocomplete': {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border-strong)',
    borderRadius: 'var(--radius-md)',
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.12)',
    fontFamily: 'var(--font-body)',
    fontSize: '13.5px',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete > ul > li': { padding: '4px 10px', color: 'var(--color-text)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    background: 'var(--color-accent-soft)',
    color: 'var(--color-text-strong)',
  },
  '.cm-completionDetail': {
    marginLeft: '10px',
    fontStyle: 'normal',
    color: 'var(--color-text-muted)',
  },
  '.cm-completionIcon': { display: 'none' },
});

/** `[[` autocomplete for every editor mode; Tab accepts like Enter. */
export function linkCompletion(): Extension {
  return [
    autocompletion({ override: [linkSource], icons: false, activateOnTyping: true }),
    Prec.highest(keymap.of([{ key: 'Tab', run: acceptCompletion }])),
    theme,
  ];
}
