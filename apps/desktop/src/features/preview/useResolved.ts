import type { Element, Root } from 'hast';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { linksResolve, type LinkKind, type LinkTarget } from '../../ipc';
import { useVaultStore } from '../../stores/vaultStore';

/** `kind` + `target` → vault path, `null` (doesn't exist) or `undefined` (not known yet). */
export type Resolve = (kind: LinkKind, target: string) => string | null | undefined;

const keyOf = (t: LinkTarget) => `${t.kind}\u0000${t.target}`;

/** Link targets in a render tree, as `links_resolve` expects them. Markdown
 *  link targets are already vault paths; a leading `/` makes them root-based. */
export function linkTargets(tree: Root): LinkTarget[] {
  const out = new Map<string, LinkTarget>();
  const walk = (n: Root | Element) => {
    for (const c of n.children) {
      if (c.type !== 'element') continue;
      const { dataNimw, dataTarget } = c.properties;
      if (typeof dataTarget === 'string') {
        const t: LinkTarget | null =
          dataNimw === 'wikilink'
            ? { kind: 'wiki', target: dataTarget }
            : dataNimw === 'embed'
              ? { kind: 'embed', target: dataTarget }
              : dataNimw === 'link'
                ? { kind: 'markdown', target: `/${dataTarget}` }
                : null;
        if (t) out.set(keyOf(t), t);
      }
      walk(c);
    }
  };
  walk(tree);
  return [...out.values()];
}

/** Resolves the tree's links against the live file set (PG-05); re-resolves
 *  when the vault's files change. */
export function useResolved(source: string, tree: Root): Resolve {
  const targets = useMemo(() => linkTargets(tree), [tree]);
  const key = targets.map(keyOf).join('\u0001');
  const nodes = useVaultStore((s) => s.nodes);
  const [result, setResult] = useState<{ key: string; map: Map<string, string | null> }>({
    key: '',
    map: new Map(),
  });
  useEffect(() => {
    let live = true;
    if (!targets.length) return;
    void linksResolve(source, targets).then((res) => {
      if (!live || !res.ok) return;
      setResult({ key, map: new Map(targets.map((t, i) => [keyOf(t), res.value[i] ?? null])) });
    });
    return () => {
      live = false;
    };
    // `key` stands for `targets`; `nodes` re-resolves after file changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, key, nodes]);
  return useCallback(
    (kind, target) => {
      const k = keyOf({ kind, target: kind === 'markdown' ? `/${target}` : target });
      return result.map.has(k) ? result.map.get(k) : undefined;
    },
    [result],
  );
}
