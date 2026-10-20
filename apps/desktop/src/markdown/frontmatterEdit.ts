// Frontmatter edits from the page header (M2c §4): cover, cover-y, subtitle.
// Only the touched keys' source text changes; every other line (order,
// comments, quoting, flow style) stays byte for byte. Invalid YAML is refused,
// never rewritten, and so is any edit whose result wouldn't read back as
// exactly the patched values (final review C2).
import { isMap, isScalar, parseDocument, Scalar, stringify, type Pair } from 'yaml';
import { parsePage } from './parse';

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/** `null` deletes the key. */
export type FrontmatterPatch = Record<string, string | number | null>;

export type FrontmatterEdit = { ok: true; change: TextChange | null } | { ok: false };

/** A leading `---` … `---` block, confirmed by the same parser the app uses. */
const BLOCK = /^---\n(?:[\s\S]*?\n)?---(?:\n|$)/;

/** Whether the text opens like a frontmatter block that BLOCK and remark
 *  don't both confirm (final review Minor 2): a byte-order mark before `---`,
 *  or a `---` line (trailing spaces allowed) with a later `---` / `...` line
 *  that some reader (remark, liber-markdown, Obsidian) could take as its end.
 *  A new block in front of it would hide it from one reader or another. */
export function unconfirmedBlock(text: string): boolean {
  const open = /^\uFEFF?---[ \t]*\r?\n/.exec(text);
  if (!open) return false;
  return text.startsWith('\uFEFF') || /^(?:---|\.\.\.)[ \t]*\r?$/m.test(text.slice(open[0].length));
}

/** The value as written: newlines folded to spaces. */
function oneLine(value: string | number): string | number {
  return typeof value === 'string' ? value.replace(/\s*\n\s*/g, ' ') : value;
}

/** One line of YAML for a scalar (newlines folded to spaces). */
function scalar(value: string | number): string {
  return stringify(oneLine(value), { lineWidth: 0 }).replace(/\n$/, '');
}

/** End of the line `end` falls in (after its `\n`). */
export function lineEnd(src: string, end: number): number {
  if (end > 0 && src[end - 1] === '\n') return end;
  const nl = src.indexOf('\n', end);
  return nl === -1 ? src.length : nl + 1;
}

/** Start of the line `pos` falls in when only spaces precede it there
 *  (a key's indentation), else `pos`. */
export function lineStart(src: string, pos: number): number {
  const start = pos === 0 ? 0 : src.lastIndexOf('\n', pos - 1) + 1;
  return /^ *$/.test(src.slice(start, pos)) ? start : pos;
}

/** A value that can be swapped in place: a one-line-able, untagged, non-empty
 *  plain or quoted scalar. Anything else (an empty value, a block scalar, a
 *  tag, a collection, an alias) has its whole pair rewritten. */
const IN_PLACE = new Set<string>([Scalar.PLAIN, Scalar.QUOTE_SINGLE, Scalar.QUOTE_DOUBLE]);

const own = (o: Record<string, unknown>, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;

/** Frontmatter source as data, or `null` when it isn't a valid mapping. */
export function data(src: string): Record<string, unknown> | null {
  const doc = parseDocument(src);
  if (doc.errors.length) return null;
  const json: unknown = doc.toJSON() ?? {};
  return typeof json === 'object' && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : null;
}

/** Whether the edited frontmatter `next` reads back as `want(before)` — the
 *  data `src` held with the edit applied: no other key changes, nothing is
 *  added — both as remark reads it (without the block's last line break) and
 *  as liber-markdown and Obsidian do. `want` answering `null` refuses. */
export function readsBackAs(
  src: string,
  next: string,
  want: (before: Record<string, unknown>) => Record<string, unknown> | null,
): boolean {
  try {
    for (const view of [(s: string) => s, (s: string) => s.replace(/\n$/, '')]) {
      const before = data(view(src));
      const after = data(view(next));
      if (!before || !after) return false;
      const wanted = want(before);
      if (!wanted) return false;
      const keys = new Set([...Object.keys(after), ...Object.keys(wanted)]);
      for (const key of keys) {
        if (JSON.stringify(own(after, key)) !== JSON.stringify(own(wanted, key))) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** `src`'s data with `patch` applied (`null` deletes a key). */
function patched(
  before: Record<string, unknown>,
  patch: FrontmatterPatch,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...before };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = oneLine(value);
  }
  return out;
}

function readsBack(src: string, next: string, patch: FrontmatterPatch): boolean {
  return readsBackAs(src, next, (before) => patched(before, patch));
}

/** The note's confirmed frontmatter block: its text, where its inside lies
 *  and that inside (`src`); `null` without one. */
export function confirmedBlock(
  text: string,
): { block: string; innerFrom: number; innerTo: number; src: string } | null {
  const m = BLOCK.exec(text);
  const block = m && parsePage(m[0]).frontmatter ? m[0] : null;
  if (!block) return null;
  const innerFrom = 4;
  const innerTo = block.length - (block.endsWith('\n') ? 4 : 3);
  return { block, innerFrom, innerTo, src: text.slice(innerFrom, innerTo) };
}

/** Applies `patch` to the note's frontmatter; `change` is `null` when nothing
 *  changes. A note without frontmatter gets a new block at the top; a block
 *  left without any content is removed. */
export function setFrontmatter(text: string, patch: FrontmatterPatch): FrontmatterEdit {
  const found = confirmedBlock(text);
  if (!found) {
    if (unconfirmedBlock(text)) return { ok: false };
    const lines = Object.entries(patch)
      .filter((e): e is [string, string | number] => e[1] !== null)
      .map(([k, v]) => `${scalar(k)}: ${scalar(v)}\n`);
    if (!lines.length) return { ok: true, change: null };
    return { ok: true, change: { from: 0, to: 0, insert: `---\n${lines.join('')}---\n` } };
  }
  const { block, innerFrom, innerTo, src } = found;
  const doc = parseDocument(src);
  if (doc.errors.length || (doc.contents !== null && !isMap(doc.contents))) return { ok: false };
  const pairs = (isMap(doc.contents) ? doc.contents.items : []) as Pair[];
  const keyOf = (p: Pair) => (isScalar(p.key) ? String(p.key.value) : null);
  type Range = [number, number, number];
  const first = pairs[0]?.key as { range?: Range } | undefined;
  const indent = first?.range ? src.slice(lineStart(src, first.range[0]), first.range[0]) : '';

  // Edits on `src`, applied back to front.
  const edits: TextChange[] = [];
  let appended = '';
  for (const [key, value] of Object.entries(patch)) {
    const pair = pairs.find((p) => keyOf(p) === key);
    if (!pair) {
      if (value !== null) appended += `${indent}${scalar(key)}: ${scalar(value)}\n`;
      continue;
    }
    const k = pair.key as { range: Range };
    const v = pair.value as { range?: Range } | null;
    // The pair runs from its key to the end of the line its value ends on.
    const valueEnd = v?.range?.[1] ?? k.range[1];
    const end = lineEnd(src, valueEnd);
    if (value === null) {
      edits.push({ from: lineStart(src, k.range[0]), to: end, insert: '' });
      continue;
    }
    if (isScalar(pair.value) && pair.value.value === oneLine(value)) continue;
    if (
      isScalar(pair.value) &&
      !pair.value.tag &&
      IN_PLACE.has(pair.value.type ?? '') &&
      v?.range &&
      v.range[0] < v.range[1]
    ) {
      edits.push({ from: v.range[0], to: v.range[1], insert: scalar(value) });
      continue;
    }
    // Rewrite the pair as `key: value`, keeping a comment that ended its line.
    const keySrc = src.slice(k.range[0], k.range[1]);
    const tail = src.slice(valueEnd, end).replace(/\n$/, '');
    const comment = /^\s*#/.test(tail) ? ` ${tail.trim()}` : '';
    const nl = src[end - 1] === '\n' ? '\n' : '';
    edits.push({ from: k.range[0], to: end, insert: `${keySrc}: ${scalar(value)}${comment}${nl}` });
  }
  if (!edits.length && !appended) return { ok: true, change: null };
  let next = src;
  for (const e of edits.sort((a, b) => b.from - a.from)) {
    next = next.slice(0, e.from) + e.insert + next.slice(e.to);
  }
  if (appended && next && !next.endsWith('\n')) next += '\n';
  next += appended;
  if (!readsBack(src, next, patch)) return { ok: false };
  if (!next.trim()) {
    return { ok: true, change: { from: 0, to: block.length, insert: '' } };
  }
  return { ok: true, change: { from: innerFrom, to: innerTo, insert: next } };
}
