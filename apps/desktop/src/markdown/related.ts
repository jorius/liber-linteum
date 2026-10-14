// Relationships (M3b §5, GV-22–24): the `related:` list of a page's
// frontmatter. A plain relationship is the string "[[Page]]"; a labelled or
// directed one is a map { link: "[[Page]]", label: …, directed: true }.
// Edits keep M2c's guarantees: only the touched item's text changes (or the
// `related:` pair when its form must change), and every edit is read back and
// refused unless the data is exactly what was asked for.
import { isMap, isScalar, isSeq, parseDocument, stringify, type Pair } from 'yaml';
import {
  confirmedBlock,
  data,
  lineEnd,
  lineStart,
  readsBackAs,
  unconfirmedBlock,
  type FrontmatterEdit,
} from './frontmatterEdit';

/** One relationship as written in `related:`. */
export interface RelatedEntry {
  /** Position in the list (a single value written without a list: 0). */
  index: number;
  /** The link as written, `[[Target#Heading|alias]]`. */
  link: string;
  /** Its target, as `[[Target]]` names it. */
  target: string;
  label: string | null;
  directed: boolean;
}

/** What a relationship's label and arrow become. */
export interface RelatedChange {
  label: string | null;
  directed: boolean;
}

const WIKI = /^\s*\[\[([^\]]+)\]\]\s*$/;

/** The `related:` value as a list (a single value is a one-item list). */
const asList = (value: unknown): unknown[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

const linkOf = (item: unknown): string | null =>
  typeof item === 'string'
    ? item
    : item && typeof item === 'object' && typeof (item as { link?: unknown }).link === 'string'
      ? (item as { link: string }).link
      : null;

/** The relationships a note's frontmatter holds, in order. */
export function readRelated(text: string): RelatedEntry[] {
  const found = confirmedBlock(text);
  const fm = found ? data(found.src) : null;
  if (!fm) return [];
  return asList(fm.related).flatMap((item, index) => {
    const link = linkOf(item);
    const m = link ? WIKI.exec(link) : null;
    if (!link || !m) return [];
    const target = m[1].split('|')[0].split('#')[0].trim();
    if (!target) return [];
    const map = typeof item === 'object' && item ? (item as Record<string, unknown>) : {};
    const label = typeof map.label === 'string' && map.label.trim() ? map.label : null;
    const directed = map.directed === true || map.directed === 'true';
    return [{ index, link: link.trim(), target, label, directed }];
  });
}

/** One list item: the string form, or the map form when it has a label or an
 *  arrow (flow style, so the item stays one line). */
function itemYaml(link: string, change: RelatedChange): string {
  const label = change.label?.replace(/\s*\n\s*/g, ' ').trim() || null;
  if (!label && !change.directed) return stringify(link, { lineWidth: 0 }).replace(/\n$/, '');
  const map: Record<string, unknown> = { link };
  if (label) map.label = label;
  if (change.directed) map.directed = true;
  return stringify(map, { collectionStyle: 'flow', lineWidth: 0 }).replace(/\n$/, '');
}

/** The data `related:` should hold after the edit, given what it held. */
type Want = (items: unknown[]) => unknown[] | null;

type Range = [number, number, number];

/** Edits `related:` in `text`: `edit` gets the frontmatter inside (`src`),
 *  the related pair (if any) and the map's key indentation, and answers the
 *  new inside; `want` says what the list must read back as. */
function editRelated(
  text: string,
  want: Want,
  edit: (src: string, pair: Pair | null, indent: string) => string | null,
): FrontmatterEdit {
  const found = confirmedBlock(text);
  if (!found) {
    if (unconfirmedBlock(text)) return { ok: false };
    const items = want([]);
    if (!items || !items.length) return items ? { ok: true, change: null } : { ok: false };
    const next = edit('', null, '');
    if (next === null) return { ok: false };
    return { ok: true, change: { from: 0, to: 0, insert: `---\n${next}---\n` } };
  }
  const { block, innerFrom, innerTo, src } = found;
  const doc = parseDocument(src);
  if (doc.errors.length || (doc.contents !== null && !isMap(doc.contents))) return { ok: false };
  const pairs = (isMap(doc.contents) ? doc.contents.items : []) as Pair[];
  const pair = pairs.find((p) => isScalar(p.key) && p.key.value === 'related') ?? null;
  const first = pairs[0]?.key as { range?: Range } | undefined;
  const indent = first?.range ? src.slice(lineStart(src, first.range[0]), first.range[0]) : '';
  const next = edit(src, pair, indent);
  if (next === null) return { ok: false };
  if (next === src) return { ok: true, change: null };
  const ok = readsBackAs(src, next, (before) => {
    const items = want(asList(before.related));
    if (!items) return null;
    const out = { ...before };
    if (items.length) out.related = items;
    else delete out.related;
    return out;
  });
  if (!ok) return { ok: false };
  if (!next.trim()) return { ok: true, change: { from: 0, to: block.length, insert: '' } };
  return { ok: true, change: { from: innerFrom, to: innerTo, insert: next } };
}

/** The `related:` pair as a block list of `items` (source text each), from
 *  the key to the end of its value's line. */
function rewritePair(src: string, pair: Pair, indent: string, items: string[]): string {
  const k = pair.key as { range: Range };
  const v = pair.value as { range?: Range } | null;
  const end = lineEnd(src, v?.range?.[1] ?? k.range[1]);
  const from = lineStart(src, k.range[0]);
  const body = items.length
    ? `${indent}related:\n${items.map((i) => `${indent}  - ${i}\n`).join('')}`
    : '';
  return src.slice(0, from) + body + src.slice(end);
}

/** Source text of each item of the `related:` value (a single value: one). */
function itemSources(src: string, pair: Pair): string[] | null {
  const v = pair.value as { range?: Range } | null;
  if (!v || !v.range) return [];
  if (isSeq(pair.value)) {
    const out: string[] = [];
    for (const item of pair.value.items as { range?: Range }[]) {
      if (!item?.range) return null;
      const text = src.slice(item.range[0], item.range[1]).trimEnd();
      if (text.includes('\n')) return null; // a block map item: no one-line form
      out.push(text);
    }
    return out;
  }
  const text = src.slice(v.range[0], v.range[1]).trimEnd();
  // An empty value (`related:` as templates leave it) holds no item.
  if (!text && isScalar(pair.value) && pair.value.value === null) return [];
  return text && !text.includes('\n') ? [text] : null;
}

/** Appends a relationship to `[[target]]` (M3b §2). */
export function appendRelated(text: string, target: string): FrontmatterEdit {
  const link = `[[${target}]]`;
  const yaml = itemYaml(link, { label: null, directed: false });
  return editRelated(
    text,
    (items) => [...items, link],
    (src, pair, indent) => {
      if (!pair) {
        const base = src && !src.endsWith('\n') ? `${src}\n` : src;
        return `${base}${indent}related:\n${indent}  - ${yaml}\n`;
      }
      if (isSeq(pair.value) && !pair.value.flow && pair.value.items.length) {
        const items = pair.value.items as { range: Range }[];
        const firstItem = items[0].range[0];
        const prefix = src.slice(src.lastIndexOf('\n', firstItem - 1) + 1, firstItem);
        if (!/^ *- +$/.test(prefix)) return null;
        const at = lineEnd(src, items[items.length - 1].range[1]);
        const nl = at > 0 && src[at - 1] !== '\n' ? '\n' : '';
        return `${src.slice(0, at)}${nl}${prefix}${yaml}\n${src.slice(at)}`;
      }
      const sources = itemSources(src, pair);
      return sources ? rewritePair(src, pair, indent, [...sources, yaml]) : null;
    },
  );
}

/** Changes the label and arrow of relationship `index` (M3b §3). */
export function updateRelated(text: string, index: number, change: RelatedChange): FrontmatterEdit {
  const entry = readRelated(text).find((e) => e.index === index);
  if (!entry) return { ok: false };
  const yaml = itemYaml(entry.link, change);
  const label = change.label?.replace(/\s*\n\s*/g, ' ').trim() || null;
  const value: unknown =
    !label && !change.directed
      ? entry.link
      : { link: entry.link, ...(label && { label }), ...(change.directed && { directed: true }) };
  return editRelated(
    text,
    (items) => (index < items.length ? items.map((it, i) => (i === index ? value : it)) : null),
    (src, pair, indent) => {
      if (!pair) return null;
      if (isSeq(pair.value) && !pair.value.flow) {
        const item = pair.value.items[index] as { range?: Range } | undefined;
        if (!item?.range) return null;
        let end = item.range[1];
        while (end > item.range[0] && /\s/.test(src[end - 1])) end--;
        return src.slice(0, item.range[0]) + yaml + src.slice(end);
      }
      const sources = itemSources(src, pair);
      if (!sources || index >= sources.length) return null;
      return rewritePair(
        src,
        pair,
        indent,
        sources.map((s, i) => (i === index ? yaml : s)),
      );
    },
  );
}

/** Deletes relationship `index`; the last one removes the key (M3b §3). */
export function removeRelated(text: string, index: number): FrontmatterEdit {
  if (!readRelated(text).some((e) => e.index === index)) return { ok: false };
  return editRelated(
    text,
    (items) => (index < items.length ? items.filter((_, i) => i !== index) : null),
    (src, pair, indent) => {
      if (!pair) return null;
      if (isSeq(pair.value) && !pair.value.flow && pair.value.items.length > 1) {
        const item = pair.value.items[index] as { range?: Range } | undefined;
        if (!item?.range) return null;
        const from = src.lastIndexOf('\n', item.range[0] - 1) + 1;
        if (!/^ *- +$/.test(src.slice(from, item.range[0]))) return null;
        let end = item.range[1];
        while (end > item.range[0] && /\s/.test(src[end - 1])) end--;
        return src.slice(0, from) + src.slice(lineEnd(src, end));
      }
      const sources = itemSources(src, pair);
      if (sources && index < sources.length && sources.length > 1) {
        return rewritePair(
          src,
          pair,
          indent,
          sources.filter((_, i) => i !== index),
        );
      }
      // The only relationship: the whole pair goes.
      const k = pair.key as { range: Range };
      const v = pair.value as { range?: Range } | null;
      let end = v?.range?.[1] ?? k.range[1];
      while (end > k.range[0] && /\s/.test(src[end - 1])) end--;
      return src.slice(0, lineStart(src, k.range[0])) + src.slice(lineEnd(src, end));
    },
  );
}
