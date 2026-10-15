// Search text helpers (M5 §4): words split and folded as the index reads
// them, title highlights, filter words typed in the field, path trails.

/** Letters and digits: what the index's tokenizer keeps. */
const WORD = /[\p{L}\p{N}]+/gu;

/** Accent- and case-insensitive key (`Canción` → `cancion`). */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** The query's words, folded; quotes and punctuation drop out. */
export function queryWords(text: string): string[] {
  return (text.normalize('NFC').match(WORD) ?? []).map(fold).filter(Boolean);
}

export interface TextPart {
  text: string;
  hit: boolean;
}

/** `text` split into runs, `hit` where a word starts with a query word
 *  (accent- and case-insensitive, as the index matches prefixes). */
export function highlightParts(text: string, words: string[]): TextPart[] {
  const parts: TextPart[] = [];
  const push = (t: string, hit: boolean) => {
    if (!t) return;
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += t;
    else parts.push({ text: t, hit });
  };
  let at = 0;
  for (const m of text.matchAll(WORD)) {
    const start = m.index ?? 0;
    const token = m[0];
    const folded = fold(token);
    const best = words.reduce((n, w) => (folded.startsWith(w) && w.length > n ? w.length : n), 0);
    if (!best) continue;
    // How much of the original covers the folded prefix.
    let covered = 0;
    let end = 0;
    for (const ch of Array.from(token)) {
      if (covered >= best) break;
      covered += fold(ch).length;
      end += ch.length;
    }
    push(text.slice(at, start), false);
    push(token.slice(0, end), true);
    at = start + end;
  }
  push(text.slice(at), false);
  return parts;
}

export type FilterWordKind = 'tag' | 'in' | 'to' | 'from';

/** A filter word at the end of the field (M5 §10.18): `#tag`, `in:name`,
 *  `to:name`, `from:name` (`in:"two words"`). Without `final` (Space) it
 *  must be followed by whitespace; with it (Enter), it may end the text and
 *  a closing quote may be missing. */
export function takeFilterWord(
  text: string,
  final: boolean,
): { rest: string; filter: { kind: FilterWordKind; value: string } } | null {
  const m = /(^|\s)(?:#([^\s#"]+)|(in|to|from):(?:"([^"]+)("?)|([^\s"]+)))(\s*)$/i.exec(text);
  if (!m) return null;
  const [, , tag, prefix, quoted, closed, bare, trailing] = m;
  if (!final && !trailing) return null;
  if (!final && quoted !== undefined && !closed) return null;
  const rest = text.slice(0, m.index + m[1].length);
  if (tag !== undefined) {
    // Obsidian: a tag needs something other than digits.
    if (!/\D/.test(tag)) return null;
    return { rest, filter: { kind: 'tag', value: tag.replace(/\/+$/, '') } };
  }
  const value = (quoted ?? bare ?? '').trim();
  if (!value) return null;
  return { rest, filter: { kind: prefix.toLowerCase() as FilterWordKind, value } };
}

/** `Lore/Dragons/Smaug.md` → `Lore › Dragons › Smaug.md`. */
export function pathTrail(path: string): string {
  return path.split('/').join(' › ');
}
