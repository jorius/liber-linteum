// Relationships (M3b §5, GV-22–24): the `related:` list of a page's
// frontmatter. A plain relationship is the string "[[Page]]"; a labelled or
// directed one is a map { link: "[[Page]]", label: …, directed: true }.
// Edits keep M2c's guarantees: only the touched item's text changes (or the
// `related:` pair when its form must change), and every edit is read back and
// refused unless the data is exactly what was asked for.
import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  visit,
  type Pair,
  type YAMLMap,
} from 'yaml';
import {
  confirmedBlock,
  data,
  lineEnd,
  lineStart,
  readsBackAs,
  unconfirmedBlock,
  type FrontmatterEdit,
  type TextChange,
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

/** The `related:` item nodes, in the order `asList` gives their data
 *  (`null` when the value is neither a list nor a single item: an alias). */
function itemNodes(src: string): unknown[] | null {
  const doc = parseDocument(src);
  if (!isMap(doc.contents)) return null;
  const value: unknown = doc.contents.get('related', true);
  if (value === undefined || value === null) return [];
  if (isSeq(value)) return value.items;
  return isMap(value) || isScalar(value) ? [value] : null;
}

/** A label as the dialog shows it: a string as written, any other scalar as
 *  its source text (`label: 2024`, as nimw-markdown reads it); none: `null`
 *  (final review I1). */
function labelOf(item: Record<string, unknown>, node: unknown): string | null {
  const label = item.label;
  if (typeof label === 'string') return label.trim() ? label : null;
  if (typeof label !== 'number' && typeof label !== 'boolean' && typeof label !== 'bigint') {
    return null;
  }
  const n: unknown = isMap(node) ? node.get('label', true) : undefined;
  const text = isScalar(n) && typeof n.source === 'string' ? n.source : String(label);
  return text.trim() ? text : null;
}

/** The relationships a note's frontmatter holds, in order. */
export function readRelated(text: string): RelatedEntry[] {
  const found = confirmedBlock(text);
  const fm = found ? data(found.src) : null;
  if (!found || !fm) return [];
  const nodes = itemNodes(found.src);
  return asList(fm.related).flatMap((item, index) => {
    const link = linkOf(item);
    const m = link ? WIKI.exec(link) : null;
    if (!link || !m) return [];
    const target = m[1].split('|')[0].split('#')[0].trim();
    if (!target) return [];
    const map = typeof item === 'object' && item ? (item as Record<string, unknown>) : {};
    const label = labelOf(map, nodes?.[index]);
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

/** `key: value` as one line that reads the same in a flow or a block map. */
function pairYaml(key: string, value: unknown): string {
  return stringify({ [key]: value }, { collectionStyle: 'flow', lineWidth: 0 })
    .replace(/\n$/, '')
    .slice(2, -2);
}

/** Whether a node holds a comment anywhere inside. */
function hasComments(node: unknown): boolean {
  let found = false;
  visit(node as Parameters<typeof visit>[0], (_key, n) => {
    const c = n as { comment?: string | null; commentBefore?: string | null } | null;
    if (c?.comment || c?.commentBefore) found = true;
  });
  return found;
}

/** What one map item's `label` and `directed` pairs become: `undefined`
 *  leaves the pair as written, `null` removes it. */
interface MapChange {
  label: string | null | undefined;
  directed: true | null | undefined;
}

/** Edits of a map item that change only its `label` and `directed` pairs:
 *  every other key (and a label that isn't changed, e.g. `label: 2024`)
 *  stays byte for byte (final review I1). New pairs go after the last one.
 *  `null` when the map can't be edited in place safely. */
function mapEdits(src: string, map: YAMLMap, change: MapChange): TextChange[] | null {
  const pairs = map.items as Pair[];
  const keyOf = (p: Pair) => (isScalar(p.key) ? p.key.value : undefined);
  const rangeOf = (p: Pair) => {
    const k = (p.key as { range?: Range } | null)?.range;
    const v = (p.value as { range?: Range } | null)?.range;
    return k ? { from: k[0], to: v ? Math.max(v[1], k[1]) : k[1] } : null;
  };
  const edits: TextChange[] = [];
  let appended: string[] = [];
  for (const key of ['label', 'directed'] as const) {
    const value = change[key];
    if (value === undefined) continue;
    const at = pairs.findIndex((p) => keyOf(p) === key);
    const pair = pairs[at];
    if (!pair) {
      if (value !== null) appended = [...appended, pairYaml(key, value)];
      continue;
    }
    const r = rangeOf(pair);
    if (!r) return null;
    if (value !== null) {
      edits.push({ from: r.from, to: r.to, insert: pairYaml(key, value) });
      continue;
    }
    // Removed: with the separator before it (or after it, when it's first).
    const prev = at > 0 ? rangeOf(pairs[at - 1]) : null;
    const next = at + 1 < pairs.length ? rangeOf(pairs[at + 1]) : null;
    if (map.flow) {
      if (prev) {
        if (src.slice(prev.to, r.from).includes('#')) return null;
        edits.push({ from: prev.to, to: r.to, insert: '' });
      } else if (next) {
        if (src.slice(r.to, next.from).includes('#')) return null;
        edits.push({ from: r.from, to: next.from, insert: '' });
      } else return null;
    } else if (prev) {
      const from = lineStart(src, r.from);
      if (from === r.from && from > 0 && src[from - 1] !== '\n') return null;
      edits.push({ from, to: lineEnd(src, r.to), insert: '' });
    } else if (next && /^[ \t]*\n[ \t]*$/.test(src.slice(r.to, next.from))) {
      edits.push({ from: r.from, to: next.from, insert: '' });
    } else return null;
  }
  if (appended.length) {
    const last = rangeOf(pairs[pairs.length - 1]);
    const first = rangeOf(pairs[0]);
    if (!last || !first) return null;
    if (map.flow) {
      edits.push({ from: last.to, to: last.to, insert: appended.map((p) => `, ${p}`).join('') });
    } else {
      const column = first.from - (src.lastIndexOf('\n', first.from - 1) + 1);
      const at = lineEnd(src, last.to);
      const nl = at > 0 && src[at - 1] !== '\n' ? '\n' : '';
      const lines = appended.map((p) => `${' '.repeat(column)}${p}\n`).join('');
      edits.push({ from: at, to: at, insert: nl + lines });
    }
  }
  return edits;
}

/** `text` with `edits` (positions in `text` plus `offset`) applied. */
function applied(text: string, edits: TextChange[], offset = 0): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, e.from - offset) + e.insert + out.slice(e.to - offset);
  }
  return out;
}

/** Changes the label and arrow of relationship `index` (M3b §3). A map item
 *  keeps its other keys, and a label the change leaves as it is keeps its
 *  YAML type (final review I1). */
export function updateRelated(text: string, index: number, change: RelatedChange): FrontmatterEdit {
  const entry = readRelated(text).find((e) => e.index === index);
  if (!entry) return { ok: false };
  const label = change.label?.replace(/\s*\n\s*/g, ' ').trim() || null;
  const sameLabel = label === entry.label;
  const sameArrow = change.directed === entry.directed;
  if (sameLabel && sameArrow) return { ok: true, change: null };
  const yaml = itemYaml(entry.link, { label, directed: change.directed });
  const mapChange: MapChange = {
    label: sameLabel ? undefined : label,
    directed: sameArrow ? undefined : change.directed || null,
  };
  // Set while editing: a map left with only its link (and no comment)
  // turns back into the string form.
  let collapsed = false;
  const value = (item: unknown): unknown => {
    if (!item || typeof item !== 'object') {
      return !label && !change.directed
        ? entry.link
        : { link: entry.link, ...(label && { label }), ...(change.directed && { directed: true }) };
    }
    const out: Record<string, unknown> = { ...(item as Record<string, unknown>) };
    for (const key of ['label', 'directed'] as const) {
      const v = mapChange[key];
      if (v === null) delete out[key];
      else if (v !== undefined) out[key] = v;
    }
    return collapsed ? entry.link : out;
  };
  /** The item's new text, as edits of `src`. */
  const itemEdits = (src: string, node: unknown): TextChange[] | null => {
    const r = (node as { range?: Range } | null)?.range;
    if (!r) return null;
    let end = r[1];
    while (end > r[0] && /\s/.test(src[end - 1])) end--;
    if (!isMap(node)) return isScalar(node) ? [{ from: r[0], to: end, insert: yaml }] : null;
    const pairs = node.items as Pair[];
    const keys = pairs.map((p) => (isScalar(p.key) ? p.key.value : p.key));
    const kept = keys.filter((k) => (k !== 'label' && k !== 'directed') || mapChange[k] !== null);
    const adds = (['label', 'directed'] as const).filter(
      (k) => mapChange[k] != null && !keys.includes(k),
    );
    // A comment inside the map would go with it.
    const commented =
      pairs.some((p) => hasComments(p.key) || hasComments(p.value)) ||
      (!node.flow && Boolean(node.comment || node.commentBefore));
    if (kept.length === 1 && kept[0] === 'link' && !adds.length && !commented) {
      collapsed = true;
      return [
        { from: r[0], to: end, insert: itemYaml(entry.link, { label: null, directed: false }) },
      ];
    }
    return mapEdits(src, node, mapChange);
  };
  return editRelated(
    text,
    (items) => (index < items.length ? items.map((it, i) => (i === index ? value(it) : it)) : null),
    (src, pair, indent) => {
      if (!pair) return null;
      const seq = isSeq(pair.value);
      const node: unknown = seq ? (pair.value as { items: unknown[] }).items[index] : pair.value;
      if (!seq && index !== 0) return null;
      const edits = itemEdits(src, node);
      if (!edits) return null;
      if (seq && !(pair.value as { flow?: boolean }).flow) return applied(src, edits);
      const sources = itemSources(src, pair);
      const r = (node as { range: Range }).range;
      if (!sources || index >= sources.length) return null;
      const own = applied(src.slice(r[0], r[1]), edits, r[0]).trimEnd();
      if (own.includes('\n')) return null;
      return rewritePair(
        src,
        pair,
        indent,
        sources.map((s, i) => (i === index ? own : s)),
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
