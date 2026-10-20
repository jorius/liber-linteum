import type { Element, Root } from 'hast';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { linksExternal, type ExternalFile, type LinkKind, type LinkTarget } from '../../ipc';
import { looksExternal } from '../../markdown/externalPath';
import { useEditorStore } from '../../stores/editorStore';
import { useOutsideStore } from '../../stores/outsideStore';
import { useVaultStore } from '../../stores/vaultStore';

/** `kind` + `target` → the outside file it names, `null` (a vault target) or
 *  `undefined` (not known yet). */
export type ExternalLookup = (kind: LinkKind, target: string) => ExternalFile | null | undefined;

const keyOf = (t: LinkTarget) => `${t.kind}\u0000${t.target}`;

/** Targets in a render tree that may name a file outside the vault (M4b part
 *  3 §9): wiki links and embeds with a path form, and the Markdown links and
 *  images the sanitizer marked with `data-external` (as the index reads them). */
export function externalTargets(tree: Root): LinkTarget[] {
  const out = new Map<string, LinkTarget>();
  const walk = (n: Root | Element) => {
    for (const c of n.children) {
      if (c.type !== 'element') continue;
      const { dataLiber, dataTarget, dataExternal } = c.properties;
      let t: LinkTarget | null = null;
      if (typeof dataExternal === 'string') {
        t = { kind: c.tagName === 'a' ? 'markdown' : 'markdown_image', target: dataExternal };
      } else if (
        typeof dataTarget === 'string' &&
        (dataLiber === 'wikilink' || dataLiber === 'embed') &&
        looksExternal(dataTarget)
      ) {
        t = { kind: dataLiber === 'embed' ? 'embed' : 'wiki', target: dataTarget };
      }
      if (t) out.set(keyOf(t), t);
      walk(c);
    }
  };
  walk(tree);
  return [...out.values()];
}

/** Asks Rust about the tree's outside targets; again when the vault's files
 *  change, the page is saved (a link becomes showable once a saved page
 *  holds it) or the user loads a network file. */
export function useExternal(source: string, tree: Root): ExternalLookup {
  const targets = useMemo(() => externalTargets(tree), [tree]);
  const key = targets.map(keyOf).join('\u0001');
  const nodes = useVaultStore((s) => s.nodes);
  const saved = useEditorStore((s) => (s.path === source ? s.hash : null));
  const loads = useOutsideStore((s) => s.loads);
  const [result, setResult] = useState<Map<string, ExternalFile | null>>(() => new Map());
  useEffect(() => {
    let live = true;
    if (!targets.length) return;
    void linksExternal(source, targets).then((res) => {
      if (!live || !res.ok) return;
      setResult(new Map(targets.map((t, i) => [keyOf(t), res.value[i] ?? null])));
    });
    return () => {
      live = false;
    };
    // `key` stands for `targets`; `nodes`, `saved` and `loads` (a network
    // file loaded) ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, key, nodes, saved, loads]);
  return useCallback(
    (kind, target) => {
      const k = keyOf({ kind, target });
      return result.has(k) ? result.get(k) : undefined;
    },
    [result],
  );
}
