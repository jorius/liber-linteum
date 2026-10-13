import type { Node, Parent } from 'mdast';

/** Depth-first list of every node of `type` (document order). */
export function findAll<T extends Node>(tree: Node, type: string): T[] {
  const out: T[] = [];
  const walk = (node: Node) => {
    if (node.type === type) out.push(node as T);
    const children = (node as Parent).children;
    if (children) for (const child of children) walk(child);
  };
  walk(tree);
  return out;
}

/** Start/end offsets of a positioned node. */
export function rangeOf(node: Node): [number, number] {
  return [node.position?.start.offset ?? 0, node.position?.end.offset ?? 0];
}
