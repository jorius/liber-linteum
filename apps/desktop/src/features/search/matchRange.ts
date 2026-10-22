// Opening a search result at its match: the word the index highlighted in the
// hit's snippet, found again in the page's text. Pure; the editor applies it.

const FRONTMATTER = /^\uFEFF?---[ \t]*(?:\r\n?|\n)[\s\S]*?(?:\r\n?|\n)---[ \t]*(?:\r\n?|\n|$)/;

/** UTF-16 offset where the page's body starts: after its frontmatter, if any. */
export function bodyStart(text: string): number {
  return FRONTMATTER.exec(text)?.[0].length ?? 0;
}

/** The first occurrence of `word` in the body of `text`, ignoring case;
 *  `null` when it isn't there (the page changed since it was indexed). */
export function matchRange(text: string, word: string): { from: number; to: number } | null {
  const needle = word.trim();
  if (!needle) return null;
  const start = bodyStart(text);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new RegExp(escaped, 'iu').exec(text.slice(start));
  return found ? { from: start + found.index, to: start + found.index + found[0].length } : null;
}
