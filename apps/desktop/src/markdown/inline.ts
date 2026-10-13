// Inline extensions found inside mdast text nodes (M2a spec §2.1): wikilinks,
// embeds, ==highlights== and #tags. The scan runs on the *source* slice of a
// text node — so escapes (`\[[`, the table form `\|`) are still visible — and
// the plain text between matches is decoded like mdast text values.
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
 * decoded, continuation-line indentation dropped. */
function plainValue(raw: string): string {
  return decodeString(raw).replace(/\n[ \t]+/g, '\n');
}

/**
 * Splits one text node into text + extension nodes. `src` is the whole
 * document; `before` is the source character just before the node (for the
 * tag rule). Returns `null` when the node contains no extension.
 */
export function scanText(src: string, node: Text, loc: Locator): PhrasingContent[] | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return null;
  const s = src.slice(start, end);
  if (!/\[\[|==|#/.test(s)) return null;
  const out = scan(s, start, src[start - 1] ?? '', loc);
  return out.length === 1 && out[0].type === 'text' ? null : out;
}

function scan(s: string, base: number, prevChar: string, loc: Locator): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let plainStart = 0;
  const flush = (to: number) => {
    if (to > plainStart) {
      out.push({
        type: 'text',
        value: plainValue(s.slice(plainStart, to)),
        position: loc.position(base + plainStart, base + to),
      });
    }
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const escaped = i > 0 && s[i - 1] === '\\';
    // [[wikilink]] / ![[embed]]
    if (ch === '[' && s[i + 1] === '[' && !escaped) {
      const close = s.indexOf(']]', i + 2);
      const inner = close >= 0 ? s.slice(i + 2, close) : '';
      const parts =
        close >= 0 && !inner.includes('\n') && !inner.includes('[[') ? parseWikiInner(inner) : null;
      if (parts) {
        const embed = i > 0 && s[i - 1] === '!' && !(i > 1 && s[i - 2] === '\\');
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
    if (ch === '=' && s[i + 1] === '=' && !escaped) {
      const close = s.indexOf('==', i + 2);
      if (close > i + 2 && !/^\s|\s$/.test(s.slice(i + 2, close))) {
        flush(i);
        const children = scan(s.slice(i + 2, close), base + i + 2, '=', loc);
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
      const name = tagAt(s, i, i === 0 ? prevChar : s[i - 1]);
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
  flush(s.length);
  return out;
}
