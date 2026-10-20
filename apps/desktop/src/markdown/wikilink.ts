/** Parts of the inside of `[[…]]`, mirroring `liber_markdown::wikilink::parse_inner`. */
export interface WikiParts {
  target: string;
  heading: string | null;
  alias: string | null;
}

/** Splits `target#heading|alias` (the table form `target\|alias` too).
 * Returns `null` for an empty target (e.g. `[[#Heading]]`). */
export function parseWikiInner(inner: string): WikiParts | null {
  let targetPart = inner;
  let alias: string | null = null;
  const bar = inner.indexOf('|');
  if (bar >= 0) {
    const escaped = bar > 0 && inner[bar - 1] === '\\';
    targetPart = inner.slice(0, escaped ? bar - 1 : bar);
    alias = inner.slice(bar + 1);
  }
  let heading: string | null = null;
  const hash = targetPart.indexOf('#');
  if (hash >= 0) {
    heading = targetPart.slice(hash + 1);
    targetPart = targetPart.slice(0, hash);
  }
  const target = targetPart.trim();
  if (!target) return null;
  return { target, heading: heading || null, alias: alias || null };
}

/** Obsidian embed size: `300` or `300x200`. */
export function parseSize(alias: string | null): { width: number | null; height: number | null } {
  const m = alias ? /^\s*(\d+)(?:\s*x\s*(\d+))?\s*$/.exec(alias) : null;
  if (!m) return { width: null, height: null };
  return { width: Number(m[1]), height: m[2] ? Number(m[2]) : null };
}
