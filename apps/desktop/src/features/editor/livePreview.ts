// Live Preview (M2a §3.2): the Markdown model drives CodeMirror decorations.
// Markup is hidden except on lines the selection touches; blocks render as
// preview widgets; large notes get a reduced set.
import {
  Facet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import type { Heading, Image, Link, ListItem, Node, Parent, RootContent } from 'mdast';
import { linksResolve, type LinkKind } from '../../ipc';
import { reparse } from '../../markdown/incremental';
import { parsePage } from '../../markdown/parse';
import { toSafeHast, vaultJoin } from '../../markdown/sanitize';
import type { Embed, ParsedPage, WikiLink } from '../../markdown/types';
import { rangeOf } from '../../markdown/walk';
import { followLink } from '../../stores/links';
import { CheckboxWidget, CodeBadgeWidget, InlineMathWidget, PreviewWidget } from './widgets';

import { LARGE_NOTE_CHARS } from './limits';
import { safeDecode } from '../../markdown/decode';

export { LARGE_NOTE_CHARS };
/** Re-parse delay after typing; positions are mapped until then. */
export const REPARSE_MS = 150;

/** The open page's vault path (links and embeds resolve from it). */
export const pagePath = Facet.define<() => string, () => string>({
  combine: (values) => values[0] ?? (() => ''),
});

interface Model {
  page: ParsedPage;
  /** The text `page` was parsed from. */
  text: string;
  /** Doc changed since `page` was parsed (decorations are mapped). */
  stale: boolean;
  /** Lines the selection touched when `decos` were built. */
  active: string;
  decos: DecorationSet;
}

const setModel = StateEffect.define<{ page: ParsedPage; text: string }>();

const hide = Decoration.replace({});
const mark = (cls: string) => Decoration.mark({ class: cls });
const MARKS = {
  emphasis: mark('cm-nimw-em'),
  strong: mark('cm-nimw-strong'),
  delete: mark('cm-nimw-strike'),
  highlight: mark('cm-nimw-highlight'),
  inlineCode: mark('cm-nimw-code'),
  link: mark('cm-nimw-link'),
  tag: mark('cm-nimw-tag'),
};
const lineClass = (cls: string) => Decoration.line({ class: cls });

const BLOCK_WIDGET = new Set(['table', 'callout', 'columns', 'thematicBreak', 'math']);
const TASK = /^(\s*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\]/;

/** Whether an HTML block renders nothing once sanitized (comments, scripts):
 *  such blocks keep their source, muted, so nothing silently disappears
 *  (M2c §7.7). Memoized by source text. */
const emptyHtml = new Map<string, boolean>();
function rendersEmpty(source: string): boolean {
  let empty = emptyHtml.get(source);
  if (empty === undefined) {
    const visible = (n: { type: string; value?: unknown; children?: unknown[] }): boolean =>
      n.type === 'element' ||
      (n.type === 'text' && typeof n.value === 'string' && n.value.trim() !== '') ||
      (n.children ?? []).some((c) => visible(c as never));
    empty = !visible(toSafeHast(parsePage(source), { sourcePath: '' }) as never);
    if (emptyHtml.size > 200) emptyHtml.clear();
    emptyHtml.set(source, empty);
  }
  return empty;
}

function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const last = state.doc.lineAt(r.to).number;
    for (let n = state.doc.lineAt(r.from).number; n <= last; n++) lines.add(n);
  }
  return lines;
}

const childRange = (node: Parent): [number, number] | null => {
  const kids = node.children as Node[];
  const last = kids[kids.length - 1] as Node | undefined;
  if (!last || !kids[0].position || !last.position) return null;
  return [rangeOf(kids[0])[0], rangeOf(last)[1]];
};

function build(state: EditorState, page: ParsedPage, active: Set<number>): DecorationSet {
  const doc = state.doc;
  const text = (from: number, to: number) => doc.sliceString(from, to);
  const reduced = doc.length > LARGE_NOTE_CHARS;
  const path = state.facet(pagePath)();
  const out: Range<Decoration>[] = [];
  const touched = (from: number, to: number) => {
    const last = doc.lineAt(Math.min(to, doc.length)).number;
    for (let n = doc.lineAt(from).number; n <= last; n++) if (active.has(n)) return true;
    return false;
  };
  const conceal = (from: number, to: number) => {
    if (from < to) out.push(hide.range(from, to));
  };
  const lines = (from: number, to: number, deco: Decoration) => {
    const last = doc.lineAt(Math.min(to, doc.length)).number;
    for (let n = doc.lineAt(from).number; n <= last; n++) out.push(deco.range(doc.line(n).from));
  };
  /** Wrapping markup around children: show content, hide the rest. */
  const wrapped = (node: Parent, deco: Decoration) => {
    const [from, to] = rangeOf(node);
    const inner = childRange(node);
    if (!inner || inner[0] >= inner[1]) return;
    out.push(deco.range(inner[0], inner[1]));
    if (!touched(from, to)) {
      conceal(from, inner[0]);
      conceal(inner[1], to);
    }
  };
  const blockWidget = (node: Node) => {
    const [from, to] = rangeOf(node);
    const start = doc.lineAt(from).from;
    const end = doc.lineAt(Math.min(to, doc.length)).to;
    out.push(
      Decoration.replace({
        widget: new PreviewWidget(text(start, end), path),
        block: true,
      }).range(start, end),
    );
  };
  const isLoneEmbed = (node: Parent) => {
    const kids = (node.children as RootContent[]).filter(
      (c) => !(c.type === 'text' && !c.value.trim()),
    );
    return kids.length === 1 && (kids[0].type === ('embed' as string) || kids[0].type === 'image');
  };

  const visit = (node: Node) => {
    if (!node.position) return;
    const [from, to] = rangeOf(node);
    const type = node.type as string;
    if (!reduced) {
      if (
        (BLOCK_WIDGET.has(type) || (type === 'paragraph' && isLoneEmbed(node as Parent))) &&
        !touched(from, to)
      ) {
        blockWidget(node);
        return;
      }
    }
    switch (type) {
      case 'heading': {
        const line = doc.lineAt(from);
        out.push(lineClass(`cm-nimw-h${(node as Heading).depth}`).range(line.from));
        const marks = /^ {0,3}#{1,6}(?:[ \t]+|$)/.exec(line.text);
        if (marks && !touched(from, to)) conceal(line.from, line.from + marks[0].length);
        break;
      }
      case 'emphasis':
      case 'strong':
      case 'delete':
      case 'highlight':
        wrapped(node as Parent, MARKS[type]);
        break;
      case 'link':
        wrapped(node as Parent, MARKS.link);
        break;
      case 'wikiLink': {
        const inner = text(from + 2, to - 2);
        // First `|`, escaped or not (`[[a\|b]]` is the table form), as in parseWikiInner.
        const bar = inner.indexOf('|');
        const show: [number, number] = bar >= 0 ? [from + 2 + bar + 1, to - 2] : [from + 2, to - 2];
        if (show[0] < show[1]) out.push(MARKS.link.range(show[0], show[1]));
        if (!touched(from, to)) {
          conceal(from, show[0]);
          conceal(show[1], to);
        }
        return;
      }
      case 'inlineCode': {
        if (reduced) return;
        const ticks = /^`+/.exec(text(from, to))?.[0].length ?? 1;
        if (from + ticks < to - ticks) out.push(MARKS.inlineCode.range(from + ticks, to - ticks));
        if (!touched(from, to)) {
          conceal(from, from + ticks);
          conceal(to - ticks, to);
        }
        return;
      }
      case 'tag':
        if (!reduced && from < to) out.push(MARKS.tag.range(from, to));
        return;
      case 'inlineMath': {
        // M4b part 2 §3: maths renders unless the cursor is on its line.
        if (!reduced && !touched(from, to)) {
          const tex = (node as unknown as { value: string }).value;
          out.push(Decoration.replace({ widget: new InlineMathWidget(tex) }).range(from, to));
        }
        return;
      }
      case 'code': {
        if (reduced) return;
        lines(from, to, lineClass('cm-nimw-codeblock'));
        // M4b part 2 §2: a fenced block's language badge and Copy button.
        const first = doc.lineAt(from);
        const fence = /^\s*(`{3,}|~{3,})(\S*)/.exec(first.text);
        if (fence && !touched(from, to) && first.number < doc.lineAt(to).number) {
          const body = text(first.to + 1, doc.lineAt(Math.min(to, doc.length)).from);
          const code = body.endsWith('\n') ? body.slice(0, -1) : body;
          out.push(
            Decoration.widget({ widget: new CodeBadgeWidget(fence[2], code), side: 1 }).range(
              first.to,
            ),
          );
        }
        return;
      }
      case 'yaml':
        lines(from, to, lineClass('cm-nimw-frontmatter'));
        return;
      case 'blockquote':
        if (!reduced) lines(from, to, lineClass('cm-nimw-quote'));
        break;
      case 'listItem': {
        const item = node as ListItem;
        if (reduced || typeof item.checked !== 'boolean') break;
        const line = doc.lineAt(from);
        const m = TASK.exec(line.text);
        // Shown on the cursor line too, so a task can always be ticked with a
        // click (as Obsidian does); Backspace removes the whole marker.
        if (m) {
          const at = line.from + m[1].length;
          const label = line.text.slice(m[0].length).trim();
          out.push(
            Decoration.replace({ widget: new CheckboxWidget(item.checked, label) }).range(
              at,
              at + 3,
            ),
          );
        }
        break;
      }
    }
    const kids = (node as Parent).children as Node[] | undefined;
    if (kids) kids.forEach(visit);
  };
  /** Flow HTML (a root-level `html` node) renders like a table; inline HTML
   *  inside a paragraph stays text. */
  const visitHtml = (node: Node) => {
    if (!node.position) return;
    const [from, to] = rangeOf(node);
    if (reduced || touched(from, to)) return;
    if (rendersEmpty(text(from, to))) lines(from, to, lineClass('cm-nimw-muted'));
    else blockWidget(node);
  };
  page.tree.children.forEach((node) =>
    (node.type as string) === 'html' ? visitHtml(node) : visit(node),
  );
  return Decoration.set(out, true);
}

const keyOf = (lines: Set<number>) => [...lines].sort((a, b) => a - b).join(',');

const model = StateField.define<Model>({
  create(state) {
    const text = state.doc.toString();
    const page = parsePage(text);
    const active = activeLines(state);
    return { page, text, stale: false, active: keyOf(active), decos: build(state, page, active) };
  },
  update(m, tr) {
    for (const e of tr.effects) {
      if (e.is(setModel)) {
        const active = activeLines(tr.state);
        return {
          ...e.value,
          stale: false,
          active: keyOf(active),
          decos: build(tr.state, e.value.page, active),
        };
      }
    }
    if (tr.docChanged) return { ...m, stale: true, decos: m.decos.map(tr.changes) };
    if (tr.selection && !m.stale) {
      const active = activeLines(tr.state);
      const key = keyOf(active);
      if (key !== m.active) return { ...m, active: key, decos: build(tr.state, m.page, active) };
    }
    return m;
  },
  provide: (f) => EditorView.decorations.from(f, (m) => m.decos),
});

/** Brings the model up to date now (instead of after the debounce). */
function refresh(view: EditorView): Model {
  const m = view.state.field(model);
  if (!m.stale) return m;
  const text = view.state.doc.toString();
  view.dispatch({ effects: setModel.of({ page: reparse(m.page, m.text, text), text }) });
  return view.state.field(model);
}

const reparser = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null;
    constructor(private readonly view: EditorView) {}
    update(u: ViewUpdate) {
      if (!u.docChanged) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        refresh(this.view);
      }, REPARSE_MS);
    }
    destroy() {
      if (this.timer) clearTimeout(this.timer);
    }
  },
);

/** The deepest link-like node containing `pos`. */
function linkAt(page: ParsedPage, pos: number): Node | null {
  let found: Node | null = null;
  const walk = (node: Node) => {
    const [from, to] = rangeOf(node);
    if (!node.position || pos < from || pos > to) return;
    if (['wikiLink', 'embed', 'link', 'image'].includes(node.type)) found = node;
    const kids = (node as Parent).children as Node[] | undefined;
    if (kids) kids.forEach(walk);
  };
  page.tree.children.forEach(walk);
  return found;
}

async function resolveAndFollow(
  kind: LinkKind,
  query: string,
  target: string,
  heading: string | null,
  source: string,
) {
  const res = await linksResolve(source, [{ kind, target: query }]);
  if (res.ok)
    followLink({ type: 'page', kind, target, heading, resolved: res.value[0] ?? null, source });
}

/** Follows the link at `pos` (click, Mod-Enter); `false` if there is none. */
export function followLinkAt(view: EditorView, pos: number): boolean {
  const node = linkAt(refresh(view).page, pos);
  if (!node) return false;
  const source = view.state.facet(pagePath)();
  if (node.type === 'wikiLink' || node.type === 'embed') {
    const n = node as WikiLink | Embed;
    const kind: LinkKind = node.type === 'embed' ? 'embed' : 'wiki';
    void resolveAndFollow(kind, n.target, n.target, n.heading, source);
    return true;
  }
  const url = (node as Link | Image).url;
  if (/^(https?|mailto):/i.test(url)) {
    followLink({ type: 'external', url });
    return true;
  }
  if (url.startsWith('#')) {
    followLink({ type: 'anchor', heading: safeDecode(url.slice(1)) });
    return true;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
  const hash = url.indexOf('#');
  const joined = vaultJoin(source, hash >= 0 ? url.slice(0, hash) : url);
  if (!joined) return false;
  const heading = hash >= 0 ? safeDecode(url.slice(hash + 1)) || null : null;
  void resolveAndFollow('markdown', `/${joined}`, joined, heading, source);
  return true;
}

export const followLinkAtCursor = (view: EditorView): boolean =>
  followLinkAt(view, view.state.selection.main.head);

/** A rendered link's text (`.cm-nimw-link` on a line the selection does not
 *  touch, so its markup is hidden): its position, else `null`. */
function renderedLinkAt(view: EditorView, target: EventTarget | null): number | null {
  const el = target instanceof Element ? target.closest('.cm-nimw-link') : null;
  if (!el || !view.contentDOM.contains(el)) return null;
  const pos = view.posAtDOM(el, 0);
  const node = linkAt(refresh(view).page, pos);
  if (!node) return null;
  const [from, to] = rangeOf(node);
  const doc = view.state.doc;
  const active = activeLines(view.state);
  const last = doc.lineAt(Math.min(to, doc.length)).number;
  for (let n = doc.lineAt(from).number; n <= last; n++) if (active.has(n)) return null;
  return pos;
}

/** A click on a rendered link follows it, as in Obsidian; on the cursor line
 *  the link shows its source and a click places the cursor. ⌘/Ctrl-click
 *  follows any link. */
const linkClick = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0 || e.altKey || e.shiftKey) return false;
    const pos =
      e.metaKey || e.ctrlKey
        ? view.posAtCoords({ x: e.clientX, y: e.clientY })
        : renderedLinkAt(view, e.target);
    if (pos === null || !followLinkAt(view, pos)) return false;
    e.preventDefault();
    return true;
  },
});

const theme = EditorView.baseTheme({
  '.cm-nimw-h1, .cm-nimw-h2, .cm-nimw-h3, .cm-nimw-h4, .cm-nimw-h5, .cm-nimw-h6': {
    fontFamily: 'var(--font-display)',
    fontWeight: '700',
    color: 'var(--color-text-strong)',
  },
  '.cm-nimw-h1': { fontSize: '1.9em' },
  '.cm-nimw-h2': { fontSize: '1.5em' },
  '.cm-nimw-h3': { fontSize: '1.25em' },
  '.cm-nimw-h4': { fontSize: '1.1em' },
  '.cm-nimw-em': { fontStyle: 'italic' },
  '.cm-nimw-strong': { fontWeight: '700' },
  '.cm-nimw-strike': { textDecoration: 'line-through' },
  '.cm-nimw-highlight': { background: 'var(--color-highlight-bg)', borderRadius: '3px' },
  '.cm-nimw-code': {
    fontFamily: 'var(--font-source)',
    fontSize: '0.9em',
    background: 'var(--color-code-bg)',
    borderRadius: '4px',
  },
  '.cm-nimw-link': { color: 'var(--color-accent)', textDecoration: 'underline' },
  '.cm-nimw-tag': { color: 'var(--color-accent)', fontWeight: '600' },
  '.cm-nimw-codeblock': { fontFamily: 'var(--font-source)', fontSize: '0.9em' },
  '.cm-nimw-quote': { borderLeft: '3px solid var(--color-border-strong)', paddingLeft: '12px' },
  '.cm-nimw-frontmatter': { color: 'var(--color-text-muted)', fontFamily: 'var(--font-source)' },
  '.cm-nimw-muted': {
    color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-source)',
    fontSize: '0.9em',
  },
  // Rendered HTML, not editor text: CodeMirror's pre-wrapped whitespace would
  // turn the renderer's newlines into blank lines.
  '.cm-nimw-widget': { padding: '4px 0', cursor: 'default', whiteSpace: 'normal' },
  '.cm-nimw-codebadge': {
    display: 'inline-flex',
    gap: '6px',
    marginLeft: '10px',
    verticalAlign: 'middle',
    fontFamily: 'var(--font-body)',
  },
  '.cm-nimw-codebadge button': {
    font: '600 11.5px var(--font-body)',
    padding: '1px 8px',
    borderRadius: '999px',
    border: '1px solid var(--color-border-strong)',
    background: 'var(--color-surface)',
    color: 'var(--color-text-body)',
    cursor: 'pointer',
  },
  '.cm-nimw-checkbox': { margin: '0 4px 0 0', verticalAlign: 'middle', cursor: 'pointer' },
});

export function livePreview(): Extension {
  return [model, reparser, linkClick, theme];
}
