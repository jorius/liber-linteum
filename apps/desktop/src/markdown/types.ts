// Node types the Liber Linteum Markdown model adds to mdast (M2a spec §2.1).
import type { BlockContent, Data, Literal, Node, Parent, PhrasingContent, Root } from 'mdast';

/** `[[target#heading|alias]]` (also the table form `[[target\|alias]]`). */
export interface WikiLink extends Node {
  type: 'wikiLink';
  target: string;
  heading: string | null;
  alias: string | null;
  data?: Data;
}

/** `![[target#heading|300x200]]`; `alias` keeps the raw text after `|`. */
export interface Embed extends Node {
  type: 'embed';
  target: string;
  heading: string | null;
  alias: string | null;
  width: number | null;
  height: number | null;
  data?: Data;
}

/** `==text==` */
export interface Highlight extends Parent {
  type: 'highlight';
  children: PhrasingContent[];
}

/** `#tag` / `#nested/tag` (Obsidian rules). */
export interface Tag extends Node {
  type: 'tag';
  name: string;
}

/** `> [!type]- Title`. A title with text comes first in `children` as a
 *  `calloutTitle` (inline content: links, tags and formatting stay). */
export interface Callout extends Parent {
  type: 'callout';
  calloutType: string;
  /** Plain text of the title, or the type name when it has none. */
  title: string;
  foldable: boolean;
  folded: boolean;
  children: (CalloutTitle | BlockContent)[];
}

/** The text after `[!type]` on a callout's first line. */
export interface CalloutTitle extends Parent {
  type: 'calloutTitle';
  children: PhrasingContent[];
}

/** `::::columns` container holding `:::column` children. */
export interface Columns extends Parent {
  type: 'columns';
  children: Column[];
}

export interface Column extends Parent {
  type: 'column';
  children: BlockContent[];
}

/** `%% … %%` (kept only as a range; not rendered). */
export interface Comment extends Literal {
  type: 'comment';
}

declare module 'mdast' {
  interface PhrasingContentMap {
    wikiLink: WikiLink;
    embed: Embed;
    highlight: Highlight;
    tag: Tag;
  }
  interface BlockContentMap {
    callout: Callout;
    columns: Columns;
  }
  interface RootContentMap {
    wikiLink: WikiLink;
    embed: Embed;
    highlight: Highlight;
    tag: Tag;
    callout: Callout;
    calloutTitle: CalloutTitle;
    columns: Columns;
    column: Column;
  }
}

/** Same names as `liber_markdown::LinkKind::as_str()`. */
export type LinkKind = 'wiki' | 'embed' | 'markdown' | 'markdown_image' | 'related' | 'cover';

export interface LinkRef {
  kind: LinkKind;
  /** Decoded target without `#heading` (as `liber-markdown` stores it). */
  target: string;
  heading: string | null;
  alias: string | null;
  /** UTF-16 offsets of the whole link in the source. */
  range: [number, number];
}

export interface Frontmatter {
  /** Offsets of the whole `---` … `---` block. */
  range: [number, number];
  data: Record<string, unknown> | null;
  error?: string;
}

export interface ParsedPage {
  tree: Root;
  frontmatter: Frontmatter | null;
  links: LinkRef[];
  /** Tags as written, frontmatter first, de-duplicated case-insensitively. */
  tags: string[];
  /** Offsets of `%% … %%` comments (not part of the tree). */
  comments: [number, number][];
}
