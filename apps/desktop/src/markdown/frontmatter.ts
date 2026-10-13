import type { Root, Yaml } from 'mdast';
import { parse as parseYaml } from 'yaml';
import type { Frontmatter, LinkRef } from './types';
import { parseWikiInner } from './wikilink';

/** Reads the YAML frontmatter node (remark-frontmatter) if the page has one. */
export function readFrontmatter(tree: Root): Frontmatter | null {
  const node = tree.children[0];
  if (!node || node.type !== 'yaml') return null;
  const yaml = node as Yaml;
  const range: [number, number] = [yaml.position!.start.offset!, yaml.position!.end.offset!];
  try {
    const data = parseYaml(yaml.value);
    if (data === null || data === undefined) return { range, data: {} };
    if (typeof data !== 'object' || Array.isArray(data)) {
      return { range, data: null, error: 'frontmatter is not a mapping' };
    }
    return { range, data: data as Record<string, unknown> };
  } catch (e) {
    return { range, data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** `cover:` and `related:` links (same keys `nimw-markdown` reads). */
export function frontmatterLinks(fm: Frontmatter | null): LinkRef[] {
  const data = fm?.data;
  if (!fm || !data) return [];
  const out: LinkRef[] = [];
  if (typeof data.cover === 'string' && data.cover.trim()) {
    out.push({
      kind: 'cover',
      target: data.cover.trim(),
      heading: null,
      alias: null,
      range: fm.range,
    });
  }
  const related = Array.isArray(data.related) ? data.related : [];
  for (const item of related) {
    const raw =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object' && typeof (item as { link?: unknown }).link === 'string'
          ? (item as { link: string }).link
          : null;
    const m = raw ? /^\s*\[\[([^\]]+)\]\]\s*$/.exec(raw) : null;
    const parts = m ? parseWikiInner(m[1]) : null;
    if (parts) out.push({ kind: 'related', ...parts, range: fm.range });
  }
  return out;
}

/** Frontmatter `tags:` as a list or a comma/space separated string; `#` stripped. */
export function frontmatterTags(fm: Frontmatter | null): string[] {
  const tags = fm?.data?.tags;
  const list = Array.isArray(tags)
    ? tags.filter((t): t is string => typeof t === 'string')
    : typeof tags === 'string'
      ? tags.split(/[,\s]+/)
      : [];
  return list.map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
}
