// Frontmatter edits from the page header (M2c §4): cover, cover-y, subtitle.
// Only the touched keys' source text changes; every other line (order,
// comments, quoting, flow style) stays byte for byte. Invalid YAML is refused,
// never rewritten.
import { isMap, isScalar, parseDocument, stringify, type Pair } from 'yaml';
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

/** One line of YAML for a scalar (newlines folded to spaces). */
function scalar(value: string | number): string {
  const v = typeof value === 'string' ? value.replace(/\s*\n\s*/g, ' ') : value;
  return stringify(v, { lineWidth: 0 }).replace(/\n$/, '');
}

/** End of the line `end` falls in (after its `\n`). */
function lineEnd(src: string, end: number): number {
  if (end > 0 && src[end - 1] === '\n') return end;
  const nl = src.indexOf('\n', end);
  return nl === -1 ? src.length : nl + 1;
}

/** Applies `patch` to the note's frontmatter; `change` is `null` when nothing
 *  changes. A note without frontmatter gets a new block at the top; a block
 *  left without any content is removed. */
export function setFrontmatter(text: string, patch: FrontmatterPatch): FrontmatterEdit {
  const m = BLOCK.exec(text);
  const block = m && parsePage(m[0]).frontmatter ? m[0] : null;
  if (!block) {
    const lines = Object.entries(patch)
      .filter((e): e is [string, string | number] => e[1] !== null)
      .map(([k, v]) => `${scalar(k)}: ${scalar(v)}\n`);
    if (!lines.length) return { ok: true, change: null };
    return { ok: true, change: { from: 0, to: 0, insert: `---\n${lines.join('')}---\n` } };
  }
  const innerFrom = 4;
  const innerTo = block.length - (block.endsWith('\n') ? 4 : 3);
  const src = text.slice(innerFrom, innerTo);
  const doc = parseDocument(src);
  if (doc.errors.length || (doc.contents !== null && !isMap(doc.contents))) return { ok: false };
  const pairs = (isMap(doc.contents) ? doc.contents.items : []) as Pair[];
  const keyOf = (p: Pair) => (isScalar(p.key) ? String(p.key.value) : null);

  // Edits on `src`, applied back to front.
  const edits: TextChange[] = [];
  let appended = '';
  for (const [key, value] of Object.entries(patch)) {
    const pair = pairs.find((p) => keyOf(p) === key);
    if (!pair) {
      if (value !== null) appended += `${scalar(key)}: ${scalar(value)}\n`;
      continue;
    }
    const k = pair.key as { range: [number, number, number] };
    const v = pair.value as { range?: [number, number, number]; toJSON?: () => unknown } | null;
    const end = lineEnd(src, v?.range?.[2] ?? k.range[2]);
    if (value === null) {
      edits.push({ from: k.range[0], to: end, insert: '' });
    } else if (isScalar(pair.value) && v?.range) {
      if (pair.value.value === value) continue;
      edits.push({ from: v.range[0], to: v.range[1], insert: scalar(value) });
    } else {
      const keySrc = src.slice(k.range[0], k.range[1]);
      edits.push({ from: k.range[0], to: end, insert: `${keySrc}: ${scalar(value)}\n` });
    }
  }
  if (!edits.length && !appended) return { ok: true, change: null };
  let next = src;
  for (const e of edits.sort((a, b) => b.from - a.from)) {
    next = next.slice(0, e.from) + e.insert + next.slice(e.to);
  }
  if (appended && next && !next.endsWith('\n')) next += '\n';
  next += appended;
  if (!next.trim()) {
    return { ok: true, change: { from: 0, to: block.length, insert: '' } };
  }
  return { ok: true, change: { from: innerFrom, to: innerTo, insert: next } };
}
