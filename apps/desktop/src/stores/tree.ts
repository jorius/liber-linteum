// Pure helpers over the flat explorer node list (vault-relative `/` paths).
import type { TreeNode } from '../ipc';

export const parentOf = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

export const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/** Children per parent path (`''` = vault root), in backend order. */
export function childrenByParent(nodes: TreeNode[]): Map<string, TreeNode[]> {
  const map = new Map<string, TreeNode[]>();
  for (const node of nodes) {
    const parent = parentOf(node.path);
    const list = map.get(parent);
    if (list) list.push(node);
    else map.set(parent, [node]);
  }
  return map;
}

/** First of `base`, `base 1`, `base 2`, … not taken in `dir` (case-insensitive). */
export function nextFreeName(nodes: TreeNode[], dir: string, base: string, ext: string): string {
  const taken = new Set(
    nodes.filter((n) => parentOf(n.path) === dir).map((n) => nameOf(n.path).toLowerCase()),
  );
  for (let i = 0; ; i++) {
    const name = i === 0 ? base : `${base} ${i}`;
    if (!taken.has(`${name}${ext}`.toLowerCase())) return name;
  }
}

/** `path` after `from` was renamed to `to` (file or folder), or `null` if unaffected. */
export function remap(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
  return null;
}

/** Folder where "New page/folder" creates things: the selected folder, the
 * selected file's folder, or the vault root. */
export function dirFor(nodes: TreeNode[], selected: string | null): string {
  if (!selected) return '';
  const node = nodes.find((n) => n.path === selected);
  if (!node) return '';
  return node.kind === 'folder' ? node.path : parentOf(node.path);
}

/** In the vault's Archive (M5b §5.3): read-only (round 2). */
export const isArchived = (path: string) => path === '.archive' || path.startsWith('.archive/');

/** A folder's own page, `X/X.md` with the exact name (round 3b §6.1), when it
 *  is among the folder's children; never for the vault root. */
export function folderPageOf(folder: string, children: Map<string, TreeNode[]>): string | null {
  if (!folder) return null;
  const page = `${folder}/${nameOf(folder)}.md`;
  return children.get(folder)?.some((n) => n.path === page) ? page : null;
}

/** `X/X.md`: a page that is its folder's own page (round 3b §6.1). */
export const isFolderPage = (path: string): boolean =>
  parentOf(path) !== '' && nameOf(path) === `${nameOf(parentOf(path))}.md`;
