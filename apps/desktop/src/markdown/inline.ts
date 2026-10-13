// Inline extensions found inside mdast text nodes (M2a spec §2.1): wikilinks,
// embeds, ==highlights== and #tags. The scan runs on the *source* slice of a
// text node — so escapes (`\[[`, the table form `\|`) are still visible — and
// the plain text between matches is taken from the node's mdast value.
import type { PhrasingContent, Text } from 'mdast';
import { decodeString } from 'micromark-util-decode-string';
import type { locator } from './locate';
import type { Embed, Highlight, Tag, WikiLink } from './types';
import { parseSize, parseWikiInner } from './wikilink';

type Locator = ReturnType<typeof locator>;

const TAG_CHAR = /[\p{L}\p{N}_\-/]/u;

/** Obsidian tag at `i` (which holds `#`): returns the tag name or null. */
function tagAt(s: string, i: number, before: string): string | null {
  if (before !== '' && !/\s/.test(before)) return null;
  let j = i + 1;
  while (j < s.length) {
    const ch = String.fromCodePoint(s.codePointAt(j)!);
    if (!TAG_CHAR.test(ch)) break;
    j += ch.length;
  }
  const name = s.slice(i + 1, j).replace(/\/+$/, '');
  if (!name || name.startsWith('/') || /^\d+$/.test(name)) return null;
  return name;
}

/** Plain text value as mdast would have it: escapes and character references
 * decoded, continuation-line indentation dropped (fallback when the source
 * can't be aligned with the node's value). */
function plainValue(raw: string): string {
  return decodeString(raw).replace(/\n[ \t]+/g, '\n');
}

const CHAR_REF = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});/y;
const PUNCT = /[!-/:-@[-`{-~]/;

/**
 * For each offset in `s` (a text node's source), the matching offset in
 * `value` (its mdast value): escapes, character references, line prefixes
 * (`> `, list indentation) and trailing spaces exist only in the source.
 * Returns null when the two can't be aligned.
 */
function align(s: string, value: string, atLineStart: boolean): Int32Array | null {
  const map = new Int32Array(s.length + 1);
  let i = 0;
  let j = 0;
  let lineStart = atLineStart;
  while (i < s.length) {
    const ch = s[i];
    if (j < value.length && ch === value[j] && !(lineStart && /[ \t>]/.test(ch))) {
      map[i++] = j++;
      lineStart = ch === '\n';
      continue;
    }
    if (lineStart && /[ \t>]/.test(ch)) {
      // Container prefix of a continuation line: source only.
      map[i++] = j;
      continue;
    }
    lineStart = false;
    if (ch === '\\' && PUNCT.test(s[i + 1] ?? '') && value[j] === s[i + 1]) {
      map[i++] = j;
      map[i++] = j++;
      continue;
    }
    if (ch === '&') {
      CHAR_REF.lastIndex = i;
      const m = CHAR_REF.exec(s);
      const decoded = m && decodeString(m[0]);
      if (m && decoded && value.startsWith(decoded, j)) {
        for (let k = 0; k < m[0].length; k++) map[i + k] = j;
        i += m[0].length;
        j += decoded.length;
        continue;
      }
    }
    if (ch === ' ' || ch === '\t') {
      // Trailing whitespace before a line ending: dropped from the value.
      map[i++] = j;
      continue;
    }
    return null;
  }
  map[s.length] = j;
  return j === value.length ? map : null;
}

/**
 * Splits one text node into text + extension nodes. `src` is the whole
 * document. Returns `null` when the node contains no extension.
 */
export function scanText(src: string, node: Text, loc: Locator): PhrasingContent[] | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return null;
  const s = src.slice(start, end);
  if (!/\[\[|==|#/.test(s)) return null;
  // Plain runs come from the node's own value, so quote markers and escapes
  // in the source never leak into the text (I6).
  // (A callout's body starts at a line start, `> ` included.)
  const map = align(s, node.value, start === 0 || src[start - 1] === '\n');
  const plain = map
    ? (from: number, to: number) => node.value.slice(map[from], map[to])
    : (from: number, to: number) => plainValue(s.slice(from, to));
  const out = scan(s, 0, s.length, start, src[start - 1] ?? '', loc, plain);
  return out.length === 1 && out[0].type === 'text' ? null : out;
}

type Plain = (from: number, to: number) => string;

/** Scans `s[lo, hi)`; offsets stay relative to `s`, which starts at `base`. */
function scan(
  s: string,
  lo: number,
  hi: number,
  base: number,
  prevChar: string,
  loc: Locator,
  plain: Plain,
): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let plainStart = lo;
  const flush = (to: number) => {
    if (to > plainStart) {
      out.push({
        type: 'text',
        value: plain(plainStart, to),
        position: loc.position(base + plainStart, base + to),
      });
    }
  };
  let i = lo;
  while (i < hi) {
    const ch = s[i];
    const escaped = i > lo && s[i - 1] === '\\';
    // [[wikilink]] / ![[embed]]
    if (ch === '[' && s[i + 1] === '[' && i + 1 < hi && !escaped) {
      const close = s.indexOf(']]', i + 2);
      const inner = close >= 0 && close + 2 <= hi ? s.slice(i + 2, close) : '';
      const parts =
        close >= 0 && close + 2 <= hi && !inner.includes('\n') && !inner.includes('[[')
          ? parseWikiInner(inner)
          : null;
      if (parts) {
        const embed = i > lo && s[i - 1] === '!' && !(i > lo + 1 && s[i - 2] === '\\');
        const from = embed ? i - 1 : i;
        flush(from);
        const position = loc.position(base + from, base + close + 2);
        if (embed) {
          const size = parseSize(parts.alias);
          out.push({
            type: 'embed',
            target: parts.target,
            heading: parts.heading,
            alias: parts.alias,
            ...size,
            position,
          } satisfies Embed);
        } else {
          out.push({ type: 'wikiLink', ...parts, position } satisfies WikiLink);
        }
        i = close + 2;
        plainStart = i;
        continue;
      }
    }
    // ==highlight==
    if (ch === '=' && s[i + 1] === '=' && i + 1 < hi && !escaped) {
      const close = s.indexOf('==', i + 2);
      if (close > i + 2 && close + 2 <= hi && !/^\s|\s$/.test(s.slice(i + 2, close))) {
        flush(i);
        const children = scan(s, i + 2, close, base, '=', loc, plain);
        out.push({
          type: 'highlight',
          children,
          position: loc.position(base + i, base + close + 2),
        } satisfies Highlight);
        i = close + 2;
        plainStart = i;
        continue;
      }
    }
    // #tag
    if (ch === '#' && !escaped) {
      const name = tagAt(s.slice(0, hi), i, i === lo ? prevChar : s[i - 1]);
      if (name) {
        flush(i);
        out.push({
          type: 'tag',
          name,
          position: loc.position(base + i, base + i + 1 + name.length),
        } satisfies Tag);
        i += 1 + name.length;
        plainStart = i;
        continue;
      }
    }
    i++;
  }
  flush(hi);
  return out;
}
