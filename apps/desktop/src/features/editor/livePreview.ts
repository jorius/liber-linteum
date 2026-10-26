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
import { linksExternal, linksResolve, type LinkKind, type WideElements } from '../../ipc';
import { isFileTarget, looksExternal } from '../../markdown/externalPath';
import { reparse } from '../../markdown/incremental';
import { parsePage } from '../../markdown/parse';
import { PALETTE, toSafeHast, vaultJoin } from '../../markdown/sanitize';
import type { Embed, ParsedPage, WikiLink } from '../../markdown/types';
import { rangeOf } from '../../markdown/walk';
import { onLeaveVault } from '../../stores/leaveVault';
import { followLink, followOutside as followOutsideFile } from '../../stores/links';
import {
  BulletWidget,
  CheckboxWidget,
  CodeBadgeWidget,
  InlineMathWidget,
  PreviewWidget,
} from './widgets';
import { widestLine } from './wideBox';

import { LARGE_NOTE_CHARS } from './limits';
import { safeDecode } from '../../markdown/decode';
import { imageResize } from './imageResize';

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
  emphasis: mark('cm-liber-em'),
  strong: mark('cm-liber-strong'),
  delete: mark('cm-liber-strike'),
  highlight: mark('cm-liber-highlight'),
  inlineCode: mark('cm-liber-code'),
  link: mark('cm-liber-link'),
  tag: mark('cm-liber-tag'),
};
const lineClass = (cls: string) => Decoration.line({ class: cls });

const BLOCK_WIDGET = new Set(['table', 'callout', 'columns', 'thematicBreak', 'math']);
const TASK = /^((?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\]/;
const MARKER = /^(?:([-*+])|\d+[.)])[ \t]*/;
/** A code block's last line as a closing fence, after its container prefix
 *  (indent, and `>` markers inside a quote). */
const CLOSING_FENCE = /^([ \t]*(?:>[ \t]?)*[ \t]*)(`{3,}|~{3,})[ \t]*$/;
/** A quote line's first `depth` markers, after any list indent; deeper `>`
 *  belong to the content (code in a quote keeps its own). */
const QUOTE_MARKS: RegExp[] = [];
const quoteMarks = (depth: number) =>
  (QUOTE_MARKS[depth] ??= new RegExp(`^([ \\t]*)((?:>[ \\t]?){1,${depth}})`));
/** The wide-elements choice (M4b part 3) a block widget follows. */
const WIDE_KIND: Record<string, keyof WideElements> = { table: 'tables', math: 'maths' };
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp)$/i;
/** A label's opening tag: `<span>` with only `data-color` / `data-bg`
 *  (M2a §4), quoted either way; the closing tag is a bare `</span>`. */
const LABEL_OPEN = /^<span((?:\s+data-(?:color|bg)\s*=\s*(?:"[a-z]+"|'[a-z]+'))+)\s*>$/i;
const LABEL_ATTR = /data-(color|bg)\s*=\s*["']([a-z]+)["']/gi;
const SPAN_OPEN = /^<span[\s>]/i;
const SPAN_CLOSE = /^<\/span\s*>$/i;

/** The label's attributes when every colour is in the palette, else `null`. */
function labelAttrs(tag: string): Record<string, string> | null {
  const m = LABEL_OPEN.exec(tag);
  if (!m) return null;
  const attrs: Record<string, string> = {};
  for (const [, key, value] of m[1].matchAll(LABEL_ATTR)) {
    if (!(PALETTE as readonly string[]).includes(value)) return null;
    attrs[`data-${key.toLowerCase()}`] = value;
  }
  return attrs;
}

/** Whether an HTML block renders nothing once sanitized (comments, scripts):
 *  such blocks keep their source, muted, so nothing silently disappears
 *  (M2c §7.7). Memoized by source text. */
const emptyHtml = new Map<string, boolean>();
onLeaveVault(() => emptyHtml.clear());
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
  const blockWidget = (node: Node, kind: keyof WideElements | null = null) => {
    const [from, to] = rangeOf(node);
    const start = doc.lineAt(from).from;
    const end = doc.lineAt(Math.min(to, doc.length)).to;
    out.push(
      Decoration.replace({
        widget: new PreviewWidget(text(start, end), path, kind),
        block: true,
      }).range(start, end),
    );
  };
  /** Lines shown as source that may escape the measure with `kind` (M4b
   *  part 3): one box as wide as the block's widest line, in `ch`. */
  const wideLines = (from: number, to: number, kind: keyof WideElements, cls?: string) => {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(Math.min(to, doc.length)).number;
    const texts: string[] = [];
    for (let n = first; n <= last; n++) texts.push(doc.line(n).text);
    const deco = Decoration.line({
      ...(cls ? { class: cls } : {}),
      attributes: { 'data-wide-src': kind, style: `--liber-ch: ${widestLine(texts)}` },
    });
    lines(from, to, deco);
  };
  const loneChild = (node: Parent): RootContent | null => {
    const kids = (node.children as RootContent[]).filter(
      (c) => !(c.type === 'text' && !c.value.trim()),
    );
    return kids.length === 1 ? kids[0] : null;
  };
  const isLoneEmbed = (node: Parent) => {
    const kid = loneChild(node);
    return !!kid && (kid.type === ('embed' as string) || kid.type === 'image');
  };
  /** A lone embed goes wide with Images when it shows an image file. */
  const embedKind = (node: Parent): keyof WideElements | null => {
    const kid = loneChild(node);
    if (kid?.type === 'image') return 'images';
    const target = kid && (kid as unknown as Embed).target;
    return typeof target === 'string' && IMAGE_FILE.test(target.replace(/[#|].*$/, ''))
      ? 'images'
      : null;
  };

  /** Labels among `node`'s children (v0.1.1): the text between a palette
   *  `<span>` and its `</span>` takes the colour, and off the cursor the tags
   *  hide. Other inline HTML stays text, and so does a span left open. */
  const labels = (node: Parent) => {
    const open: ({ attrs: Record<string, string>; from: number; to: number } | null)[] = [];
    for (const kid of node.children as Node[]) {
      if (kid.type !== 'html' || !kid.position) continue;
      const [from, to] = rangeOf(kid);
      const tag = text(from, to);
      if (SPAN_CLOSE.test(tag)) {
        const start = open.pop();
        if (!start) continue;
        if (start.to < from) {
          out.push(
            Decoration.mark({ class: 'cm-liber-label', attributes: start.attrs }).range(
              start.to,
              from,
            ),
          );
        }
        if (!touched(start.from, to)) {
          conceal(start.from, start.to);
          conceal(from, to);
        }
      } else if (SPAN_OPEN.test(tag)) {
        const attrs = labelAttrs(tag);
        open.push(attrs && { attrs, from, to });
      }
    }
  };
  /** Inside a blockquote: its outermost one hides every level's markers. */
  let quoteDepth = 0;
  /** Each line's quote nesting under `node` (a blockquote at `level`). */
  const quoteLevels = (node: Node, level: number, depth: Map<number, number>) => {
    if (!node.position) return;
    if (node.type === 'blockquote') {
      const [from, to] = rangeOf(node);
      const last = doc.lineAt(Math.min(to, doc.length)).number;
      for (let n = doc.lineAt(from).number; n <= last; n++)
        depth.set(n, Math.max(depth.get(n) ?? 0, level));
    }
    for (const kid of ((node as Parent).children as Node[] | undefined) ?? [])
      quoteLevels(kid, kid.type === 'blockquote' ? level + 1 : level, depth);
  };
  const visit = (node: Node) => {
    if (!node.position) return;
    const [from, to] = rangeOf(node);
    const type = node.type as string;
    if (!reduced) {
      if (BLOCK_WIDGET.has(type) && !touched(from, to)) {
        blockWidget(node, WIDE_KIND[type] ?? null);
        return;
      }
      if (type === 'paragraph' && isLoneEmbed(node as Parent) && !touched(from, to)) {
        blockWidget(node, embedKind(node as Parent));
        return;
      }
      // M4b part 3: a table or maths block being edited keeps its wide box. A
      // table's source is monospaced, so its lined-up columns line up.
      if (type === 'table') wideLines(from, to, 'tables', 'cm-liber-tablesrc');
      if (type === 'math') wideLines(from, to, 'maths');
    }
    switch (type) {
      case 'heading': {
        const line = doc.lineAt(from);
        out.push(lineClass(`cm-liber-h${(node as Heading).depth}`).range(line.from));
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
      case 'embed':
      case 'image':
        // v0.1.1: one that shares its paragraph (a list item's next line, a
        // sentence) renders where it is, until the cursor enters its line.
        if (!reduced && !touched(from, to)) {
          out.push(
            Decoration.replace({ widget: new PreviewWidget(text(from, to), path) }).range(from, to),
          );
        }
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
        // M4b part 2 §4: a diagram off the cursor is drawn as a block widget.
        const mermaid = (node as unknown as { lang?: string }).lang?.toLowerCase() === 'mermaid';
        if (mermaid && !touched(from, to)) {
          blockWidget(node, 'diagrams');
          return;
        }
        // M4b part 3: a diagram's source follows the Diagrams choice, so it
        // keeps its box while edited; other code follows Code blocks.
        wideLines(from, to, mermaid ? 'diagrams' : 'code', 'cm-liber-codeblock');
        const first = doc.lineAt(from);
        const last = doc.lineAt(Math.min(to, doc.length));
        out.push(lineClass('cm-liber-codeblock-first').range(first.from));
        out.push(lineClass('cm-liber-codeblock-last').range(last.from));
        // Round 3 §1: off the cursor the fences hide; the opening one becomes
        // the header row (language badge and Copy, M4b part 2 §2) and the
        // closing one an empty line, so revealing the source moves nothing.
        // The node starts after any container prefix (`> `, `- `).
        const fence = /^(`{3,}|~{3,})(\S*)/.exec(text(from, first.to));
        if (fence && !touched(from, to) && first.number < last.number) {
          // Closed only by the opening character, at least as long (CommonMark).
          const close = CLOSING_FENCE.exec(last.text);
          const closed =
            !!close && close[2][0] === fence[1][0] && close[2].length >= fence[1].length;
          const code = (node as unknown as { value: string }).value;
          out.push(
            Decoration.replace({ widget: new CodeBadgeWidget(fence[2], code) }).range(
              from,
              first.to,
            ),
          );
          if (closed) conceal(last.from + close[1].length, last.to);
        }
        return;
      }
      case 'yaml':
        lines(from, to, lineClass('cm-liber-frontmatter'));
        return;
      case 'blockquote': {
        if (reduced) break;
        lines(from, to, lineClass('cm-liber-quote'));
        if (quoteDepth === 0 && !touched(from, to)) {
          const depth = new Map<number, number>();
          quoteLevels(node, 1, depth);
          for (const [n, d] of depth) {
            const ln = doc.line(n);
            const start = Math.max(ln.from, from);
            const m = quoteMarks(d).exec(text(start, ln.to));
            if (m) conceal(start + m[1].length, start + m[0].length);
          }
        }
        quoteDepth++;
        ((node as Parent).children as Node[]).forEach(visit);
        quoteDepth--;
        return;
      }
      case 'listItem': {
        const item = node as ListItem;
        if (reduced) break;
        const line = doc.lineAt(from);
        // Round 3 §1: off its own line the marker renders (a bullet, a styled
        // number, or nothing beside a task's checkbox); children don't reveal it.
        const marker = MARKER.exec(text(from, line.to));
        if (marker && !touched(line.from, line.to)) {
          const end = from + marker[0].length;
          if (typeof item.checked === 'boolean') conceal(from, end);
          else if (marker[1])
            out.push(Decoration.replace({ widget: new BulletWidget() }).range(from, from + 1));
          else out.push(mark('cm-liber-listnum').range(from, from + marker[0].trimEnd().length));
        }
        if (typeof item.checked !== 'boolean') break;
        // From the item's start, so a task in a quote matches too.
        const m = TASK.exec(text(from, line.to));
        // Shown on the cursor line too, so a task can always be ticked with a
        // click (as Obsidian does); Backspace removes the whole marker.
        if (m) {
          const at = from + m[1].length;
          const label = text(at + 3, line.to).trim();
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
    if (kids) {
      labels(node as Parent);
      kids.forEach(visit);
    }
  };
  /** Flow HTML (a root-level `html` node) renders like a table; inline HTML
   *  inside a paragraph stays text. */
  const visitHtml = (node: Node) => {
    if (!node.position) return;
    const [from, to] = rangeOf(node);
    if (reduced || touched(from, to)) return;
    if (rendersEmpty(text(from, to))) lines(from, to, lineClass('cm-liber-muted'));
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

/** Live Preview's model of `state`'s page when it is up to date with `text`
 *  (the outline and the word count read it rather than parse the page again,
 *  final review M3); `null` without Live Preview or while it lags. Read
 *  only: the page stays Live Preview's to re-parse. */
export function livePreviewPage(state: EditorState, text: string): ParsedPage | null {
  const m = state.field(model, false);
  return m && !m.stale && m.text === text ? m.page : null;
}

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

/** Follows a file outside the vault (M4b part 3 §9) that `target` names;
 *  `false` when it names none. */
async function followOutside(kind: LinkKind, target: string, source: string): Promise<boolean> {
  const res = await linksExternal(source, [{ kind, target }]);
  const outside = res.ok ? res.value[0] : null;
  if (!outside) return false;
  followOutsideFile(outside);
  return true;
}

async function resolveAndFollow(
  kind: LinkKind,
  query: string,
  target: string,
  heading: string | null,
  source: string,
) {
  const res = await linksResolve(source, [{ kind, target: query }]);
  if (!res.ok) return;
  const resolved = res.value[0] ?? null;
  if (resolved === null && kind !== 'markdown' && looksExternal(target)) {
    if (await followOutside(kind, target, source)) return;
  }
  followLink({ type: 'page', kind, target, heading, resolved, source });
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
  const hash = url.indexOf('#');
  const path = safeDecode(hash >= 0 ? url.slice(0, hash) : url);
  // M4b part 3 §9: a drive, UNC or file: path names a file outside the vault.
  if (isFileTarget(path)) {
    void followOutside('markdown', path, source);
    return true;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
  const joined = vaultJoin(source, hash >= 0 ? url.slice(0, hash) : url);
  if (!joined) {
    // Above the vault root: outside it.
    void followOutside('markdown', path, source);
    return true;
  }
  const heading = hash >= 0 ? safeDecode(url.slice(hash + 1)) || null : null;
  void resolveAndFollow('markdown', `/${joined}`, joined, heading, source);
  return true;
}

export const followLinkAtCursor = (view: EditorView): boolean =>
  followLinkAt(view, view.state.selection.main.head);

/** A rendered link's text (`.cm-liber-link` on a line the selection does not
 *  touch, so its markup is hidden): its position, else `null`. */
function renderedLinkAt(view: EditorView, target: EventTarget | null): number | null {
  const el = target instanceof Element ? target.closest('.cm-liber-link') : null;
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
  '.cm-liber-h1, .cm-liber-h2, .cm-liber-h3, .cm-liber-h4, .cm-liber-h5, .cm-liber-h6': {
    fontFamily: 'var(--font-display)',
    fontWeight: '700',
    color: 'var(--color-text-strong)',
  },
  '.cm-liber-h1': { fontSize: '1.9em' },
  '.cm-liber-h2': { fontSize: '1.5em' },
  '.cm-liber-h3': { fontSize: '1.25em' },
  '.cm-liber-h4': { fontSize: '1.1em' },
  '.cm-liber-em': { fontStyle: 'italic' },
  '.cm-liber-strong': { fontWeight: '700' },
  '.cm-liber-strike': { textDecoration: 'line-through' },
  '.cm-liber-highlight': { background: 'var(--color-highlight-bg)', borderRadius: '3px' },
  '.cm-liber-code': {
    fontFamily: 'var(--font-source)',
    fontSize: '0.9em',
    background: 'var(--color-code-bg)',
    borderRadius: '4px',
  },
  '.cm-liber-link': { color: 'var(--color-accent)', textDecoration: 'underline' },
  '.cm-liber-tag': { color: 'var(--color-secondary)', fontWeight: '600' },
  // The palette's `--tone` comes from the shared `[data-color='…']` rules.
  '.cm-liber-label[data-color]': { color: 'var(--tone)' },
  '.cm-liber-label[data-bg]': {
    background: 'var(--tone-bg)',
    borderRadius: '3px',
    padding: '0 2px',
  },
  '.cm-liber-codeblock': {
    fontFamily: 'var(--font-source)',
    fontSize: '0.9em',
    background: 'var(--color-code-bg)',
  },
  '.cm-liber-codeblock-first': {
    borderTopLeftRadius: '8px',
    borderTopRightRadius: '8px',
    paddingTop: '4px',
  },
  '.cm-liber-codeblock-last': {
    borderBottomLeftRadius: '8px',
    borderBottomRightRadius: '8px',
    paddingBottom: '4px',
  },
  '.cm-liber-quote': { borderLeft: '3px solid var(--color-border-strong)', paddingLeft: '12px' },
  '.cm-liber-bullet': { color: 'var(--color-text-muted)', fontWeight: '700' },
  '.cm-liber-listnum': { color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' },
  '.cm-liber-frontmatter': { color: 'var(--color-text-muted)', fontFamily: 'var(--font-source)' },
  '.cm-liber-tablesrc': { fontFamily: 'var(--font-source)' },
  '.cm-liber-muted': {
    color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-source)',
    fontSize: '0.9em',
  },
  // Rendered HTML, not editor text: CodeMirror's pre-wrapped whitespace would
  // turn the renderer's newlines into blank lines.
  '.cm-liber-widget': { padding: '4px 0', cursor: 'default', whiteSpace: 'normal' },
  '.cm-liber-codebadge': {
    display: 'inline-flex',
    float: 'right',
    gap: '6px',
    verticalAlign: 'middle',
    fontFamily: 'var(--font-body)',
  },
  '.cm-liber-codebadge button': {
    font: '600 11.5px var(--font-body)',
    padding: '1px 8px',
    borderRadius: '999px',
    border: '1px solid var(--color-border-strong)',
    background: 'var(--color-surface)',
    color: 'var(--color-text-body)',
    cursor: 'pointer',
  },
  '.cm-liber-checkbox': { margin: '0 4px 0 0', verticalAlign: 'middle', cursor: 'pointer' },
  // 0.1.2: the image resize handle and the image it sizes.
  '.cm-liber-resize': {
    position: 'absolute',
    zIndex: '5',
    width: '14px',
    height: '14px',
    boxSizing: 'border-box',
    borderRadius: '4px',
    border: '2px solid var(--color-surface)',
    background: 'var(--color-accent)',
    boxShadow: '0 1px 3px rgb(0 0 0 / 0.3)',
    cursor: 'nwse-resize',
    touchAction: 'none',
  },
  '.cm-liber-resize[hidden]': { display: 'none' },
  'img.cm-liber-sizable': { outline: '2px solid var(--color-accent)', outlineOffset: '2px' },
});

export function livePreview(): Extension {
  return [model, reparser, linkClick, theme, imageResize];
}
