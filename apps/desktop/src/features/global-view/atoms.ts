// See atoms (M4b part 3 §6): a page broken into its sections and blocks,
// laid out as a tree under the page's card. Built from the same model as the
// preview (`parsePage`), so what the map shows is what the page renders.
// Pure functions; AtomsCanvas draws them.
import type { Heading, List, ListItem, Nodes, Paragraph, Parent, RootContent, Table } from 'mdast';
import { plainText } from '../../markdown/outline';
import { parsePage } from '../../markdown/parse';
import type { Callout, LinkKind, LinkRef } from '../../markdown/types';
import { CARD_H, CARD_W, ORIGIN, type XY } from './layout';

export type AtomKind =
  | 'paragraph'
  | 'list'
  | 'tasks'
  | 'quote'
  | 'callout'
  | 'code'
  | 'table'
  | 'image'
  | 'audio'
  | 'file'
  | 'note'
  | 'math'
  | 'diagram'
  | 'html';

/** An embedded file as written (`![[x]]`, `![](x)`), resolved by the canvas. */
export interface Media {
  kind: Extract<LinkKind, 'embed' | 'markdown_image'>;
  target: string;
}

export interface Atom {
  /** `atom:<n>`, in reading order. */
  id: string;
  kind: AtomKind;
  /** The section it belongs to; `null` before the first heading. */
  section: string | null;
  /** UTF-16 offsets of the block in the page text (where a click jumps). */
  from: number;
  to: number;
  /** One line to name it: the paragraph's text, a callout's title, a code
   *  block's first line, a file's name. */
  text: string;
  /** A list's first items, a code block's first lines, a table's columns. */
  lines?: string[];
  /** A code block's language. */
  lang?: string | null;
  /** List items, or table rows. */
  count?: number;
  /** Tasks done. */
  done?: number;
  /** A diagram's or a formula's source. */
  source?: string;
  media?: Media;
  /** Links in the block (to other pages, once resolved). */
  links: LinkRef[];
}

export interface Section {
  /** `section:<n>`, in reading order. */
  id: string;
  level: number;
  title: string;
  parent: string | null;
  /** The heading's start, and the section's end (the next heading of the
   *  same or a higher level, or the end of the page). */
  from: number;
  to: number;
  /** Where the cursor goes: the heading's text, after its `#`s. */
  at: number;
  /** Blocks directly in it (sub-sections' not counted). */
  blocks: number;
  links: LinkRef[];
}

/** Blocks past the card budget, per section (`null`: before the first
 *  heading): a "+N more" card opening the editor at the first of them. */
export interface More {
  id: string;
  section: string | null;
  count: number;
  from: number;
  to: number;
}

export interface AtomsModel {
  sections: Section[];
  atoms: Atom[];
  more: More[];
}

/** At most this many atom cards on the map (spec §6). */
export const MAX_ATOMS = 400;

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp']);
const AUDIO = new Set(['wav', 'mp3', 'm4a', 'ogg', 'flac']);
const LINES = 3;
const CODE_LINES = 4;

const extOf = (target: string) => {
  const name = target.slice(target.lastIndexOf('/') + 1);
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
};

const mediaKind = (target: string): AtomKind => {
  const ext = extOf(target);
  if (IMAGE.has(ext)) return 'image';
  if (AUDIO.has(ext)) return 'audio';
  return ext === '' || ext === 'md' ? 'note' : 'file';
};

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const range = (n: { position?: { start: { offset?: number }; end: { offset?: number } } }) =>
  [n.position?.start.offset ?? 0, n.position?.end.offset ?? 0] as const;

/** A paragraph holding only embeds and images (and the breaks between them):
 *  one media atom each. */
function mediaOnly(p: Paragraph): Nodes[] | null {
  const media: Nodes[] = [];
  for (const child of p.children as Nodes[]) {
    if (child.type === 'embed' || child.type === 'image') media.push(child);
    else if (child.type === 'break' || (child.type === 'text' && !child.value.trim())) continue;
    else return null;
  }
  return media.length ? media : null;
}

const itemText = (item: ListItem) => oneLine(plainText(item.children[0] ?? item));

export function buildAtoms(text: string, max = MAX_ATOMS): AtomsModel {
  const page = parsePage(text);
  const sections: Section[] = [];
  const atoms: Atom[] = [];
  const more: More[] = [];
  /** Open sections, deepest last. */
  const open: Section[] = [];
  let shown = 0;
  let n = 0;

  const current = () => (open.length ? open[open.length - 1] : null);
  const linksIn = (from: number, to: number) =>
    page.links.filter((l) => l.range[0] >= from && l.range[0] < to && l.kind !== 'related');

  const add = (atom: Omit<Atom, 'id' | 'section' | 'links'>) => {
    const section = current();
    if (section) section.blocks++;
    const key = section?.id ?? null;
    if (shown >= max) {
      const last = more[more.length - 1];
      if (last && last.section === key) {
        last.count++;
        last.to = atom.to;
      } else {
        more.push({
          id: `more:${more.length}`,
          section: key,
          count: 1,
          from: atom.from,
          to: atom.to,
        });
      }
      return;
    }
    shown++;
    atoms.push({
      ...atom,
      id: `atom:${n++}`,
      section: key,
      links: linksIn(atom.from, atom.to),
    });
  };

  const block = (node: RootContent) => {
    const [from, to] = range(node);
    switch (node.type) {
      case 'heading': {
        const h = node as Heading;
        while (open.length && open[open.length - 1].level >= h.depth) open.pop();
        const marker = /^[ \t]{0,3}#{1,6}[ \t]*/.exec(text.slice(from, from + 16));
        const section: Section = {
          id: `section:${sections.length}`,
          level: h.depth,
          title: oneLine(plainText(h)),
          parent: current()?.id ?? null,
          from,
          to: text.length,
          at: from + (marker ? marker[0].length : 0),
          blocks: 0,
          links: linksIn(from, to),
        };
        // It ends the sections it closes.
        for (const s of sections) if (s.to === text.length && s.level >= h.depth) s.to = from;
        sections.push(section);
        open.push(section);
        return;
      }
      case 'paragraph': {
        const media = mediaOnly(node);
        if (media) {
          for (const m of media) {
            const [a, b] = range(m);
            const target = m.type === 'embed' ? m.target : (m as { url: string }).url;
            add({
              kind: mediaKind(target),
              from: a,
              to: b,
              text: target.slice(target.lastIndexOf('/') + 1),
              media: { kind: m.type === 'embed' ? 'embed' : 'markdown_image', target },
            });
          }
          return;
        }
        add({ kind: 'paragraph', from, to, text: oneLine(plainText(node)) });
        return;
      }
      case 'list': {
        const list = node as List;
        const items = list.children;
        const tasks = items.some((i) => typeof i.checked === 'boolean');
        add({
          kind: tasks ? 'tasks' : 'list',
          from,
          to,
          text: itemText(items[0]),
          lines: items.slice(0, LINES).map(itemText),
          count: items.length,
          ...(tasks ? { done: items.filter((i) => i.checked === true).length } : {}),
        });
        return;
      }
      case 'blockquote':
        add({ kind: 'quote', from, to, text: oneLine(plainText(node)) });
        return;
      case 'callout': {
        const c = node as Callout;
        add({ kind: 'callout', from, to, text: oneLine(c.title) });
        return;
      }
      case 'code': {
        const lines = node.value.split('\n');
        if (node.lang?.toLowerCase() === 'mermaid') {
          add({ kind: 'diagram', from, to, text: oneLine(lines[0] ?? ''), source: node.value });
        } else {
          add({
            kind: 'code',
            from,
            to,
            text: lines[0] ?? '',
            lines: lines.slice(0, CODE_LINES),
            lang: node.lang ?? null,
          });
        }
        return;
      }
      case 'math':
        add({ kind: 'math', from, to, text: oneLine(node.value), source: node.value });
        return;
      case 'table': {
        const table = node as Table;
        const head = table.children[0];
        add({
          kind: 'table',
          from,
          to,
          text: '',
          lines: (head?.children ?? []).map((cell) => oneLine(plainText(cell))),
          count: Math.max(0, table.children.length - 1),
        });
        return;
      }
      case 'html':
        add({ kind: 'html', from, to, text: oneLine(node.value.replace(/<[^>]*>/g, ' ')) });
        return;
      case 'columns':
      case 'column' as string:
        for (const child of (node as Parent).children as RootContent[]) block(child);
        return;
      default:
        // Frontmatter, rules, definitions: nothing to show.
        return;
    }
  };

  for (const node of page.tree.children) block(node);
  // Atoms whose card is shown get their text trimmed for the card.
  for (const a of atoms) if (a.text.length > 280) a.text = `${a.text.slice(0, 279)}…`;
  return { sections, atoms, more };
}

// ---- layout ----

export const ATOM_W = 200;
export const ATOM_H = 120;
export const SECTION_W = 220;
export const SECTION_H = 64;
export const MORE_H = 56;
/** Atoms sit this far right of their section (the trunk runs in between). */
export const INDENT = 32;
const GAP_Y = 16;
const COL_GAP = 56;
const ROW_GAP = 80;
const PAGES_GAP = 140;
const PAGE_GAP_Y = 40;

export interface AtomBox extends XY {
  w: number;
  h: number;
}

export interface AtomsLayout {
  boxes: Map<string, AtomBox>;
  /** Parent/child pairs (page → section → sub-section → atom), in order. */
  tree: [string, string][];
}

/** The page's card on top; under it, left to right, the blocks before the
 *  first heading, then a column per top-level section — its card, its atoms
 *  stacked and indented, its sub-sections nested the same way; the linked
 *  pages' cards in a column on the right. Deterministic; nothing overlaps. */
export function atomsLayout(page: string, model: AtomsModel, linked: string[]): AtomsLayout {
  const boxes = new Map<string, AtomBox>();
  const tree: [string, string][] = [];
  boxes.set(page, { x: ORIGIN, y: ORIGIN, w: CARD_W, h: CARD_H });
  const top = ORIGIN + CARD_H + ROW_GAP;
  let x = ORIGIN;
  let right = ORIGIN + CARD_W;

  const atomsOf = (section: string | null) => model.atoms.filter((a) => a.section === section);
  const moreOf = (section: string | null) => model.more.filter((m) => m.section === section);
  const kids = (section: string | null) => model.sections.filter((s) => s.parent === section);

  /** Places `parent`'s atoms and "+N more" from (`at`, `y`); returns the next y. */
  const stack = (parent: string, section: string | null, at: number, y: number) => {
    for (const a of atomsOf(section)) {
      boxes.set(a.id, { x: at, y, w: ATOM_W, h: ATOM_H });
      tree.push([parent, a.id]);
      right = Math.max(right, at + ATOM_W);
      y += ATOM_H + GAP_Y;
    }
    for (const m of moreOf(section)) {
      boxes.set(m.id, { x: at, y, w: ATOM_W, h: MORE_H });
      tree.push([parent, m.id]);
      y += MORE_H + GAP_Y;
    }
    return y;
  };

  /** Places a section and everything in it from (`at`, `y`); returns the
   *  next y and the column's right edge. */
  const place = (s: Section, parent: string, at: number, y: number): number => {
    boxes.set(s.id, { x: at, y, w: SECTION_W, h: SECTION_H });
    tree.push([parent, s.id]);
    right = Math.max(right, at + SECTION_W);
    y = stack(s.id, s.id, at + INDENT, y + SECTION_H + GAP_Y);
    for (const sub of kids(s.id)) y = place(sub, s.id, at + INDENT, y);
    return y;
  };

  if (atomsOf(null).length || moreOf(null).length) {
    stack(page, null, x, top);
    x = right + COL_GAP;
  }
  for (const s of kids(null)) {
    place(s, page, x, top);
    x = right + COL_GAP;
  }
  let y = top;
  const pagesX = right + PAGES_GAP;
  for (const p of linked) {
    boxes.set(p, { x: pagesX, y, w: CARD_W, h: CARD_H });
    y += CARD_H + PAGE_GAP_Y;
  }
  return { boxes, tree };
}
