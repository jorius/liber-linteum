// The single Markdown model (M2a spec §2): unified + remark + our extensions.
// Drives Live Preview decorations, the rendered pane and (M4) block dragging.
import type { Image, Link, Parent, Root, RootContent, Text } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { findComments, maskComments, remarkContainerDirectives, transformBlocks } from './blocks';
import { frontmatterLinks, frontmatterTags, readFrontmatter } from './frontmatter';
import { scanText } from './inline';
import { locator } from './locate';
import type { Embed, LinkRef, ParsedPage, Tag, WikiLink } from './types';
import { findAll, rangeOf } from './walk';

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkContainerDirectives);

/** Parents whose text is never scanned for extensions. */
const OPAQUE = new Set(['link', 'linkReference', 'image', 'imageReference']);

function transformInline(tree: Root, src: string, loc: ReturnType<typeof locator>) {
  const walk = (parent: Parent) => {
    if (OPAQUE.has(parent.type)) return;
    const next: RootContent[] = [];
    let changed = false;
    for (const child of parent.children as RootContent[]) {
      if (child.type === 'text') {
        const parts = scanText(src, child as Text, loc);
        if (parts) {
          next.push(...parts);
          changed = true;
          continue;
        }
      } else if ('children' in child) {
        walk(child as Parent);
      }
      next.push(child);
    }
    if (changed) (parent as { children: RootContent[] }).children = next;
  };
  walk(tree);
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Decoded target of a Markdown link/image destination, or null if external. */
function markdownTarget(url: string): { target: string; heading: string | null } | null {
  if (!url || url.startsWith('#') || SCHEME.test(url)) return null;
  const hash = url.indexOf('#');
  const path = hash >= 0 ? url.slice(0, hash) : url;
  if (!path) return null;
  let target = path;
  try {
    target = decodeURIComponent(path);
  } catch {
    // keep the raw path when it isn't valid percent-encoding
  }
  const heading = hash >= 0 ? url.slice(hash + 1) || null : null;
  return { target, heading };
}

function collectLinks(tree: Root, fmLinks: LinkRef[]): LinkRef[] {
  const out: LinkRef[] = [...fmLinks];
  const walk = (node: RootContent | Root) => {
    switch (node.type) {
      case 'wikiLink': {
        const n = node as WikiLink;
        out.push({
          kind: 'wiki',
          target: n.target,
          heading: n.heading,
          alias: n.alias,
          range: rangeOf(n),
        });
        return;
      }
      case 'embed': {
        const n = node as Embed;
        out.push({
          kind: 'embed',
          target: n.target,
          heading: n.heading,
          alias: n.alias,
          range: rangeOf(n),
        });
        return;
      }
      case 'link':
      case 'image': {
        const t = markdownTarget((node as Link | Image).url);
        if (t) {
          out.push({
            kind: node.type === 'link' ? 'markdown' : 'markdown_image',
            ...t,
            alias: null,
            range: rangeOf(node),
          });
        }
        break;
      }
    }
    if ('children' in node) for (const c of (node as Parent).children) walk(c as RootContent);
  };
  walk(tree);
  return out;
}

function collectTags(tree: Root, fmTags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...fmTags, ...findAll<Tag>(tree, 'tag').map((n) => n.name)]) {
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

/** Parses one page. Pure and synchronous; positions are UTF-16 offsets into `text`. */
export function parsePage(text: string): ParsedPage {
  const loc = locator(text);
  let tree = processor.parse(text) as Root;
  // Comments are blanked (same length) and the page re-parsed, so positions
  // still index `text` but nothing inside a comment renders or links.
  const comments = findComments(text, tree);
  const source = maskComments(text, comments);
  if (comments.length) tree = processor.parse(source) as Root;
  transformBlocks(tree, source, loc);
  transformInline(tree, source, loc);
  const frontmatter = readFrontmatter(tree);
  return {
    tree,
    frontmatter,
    links: collectLinks(tree, frontmatterLinks(frontmatter)),
    tags: collectTags(tree, frontmatterTags(frontmatter)),
    comments,
  };
}
