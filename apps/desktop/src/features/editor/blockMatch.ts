// Finding a block again in another version of the note (final review C2).
// The gutter picks blocks in the version the pane shows; a move applies to
// the editor's text, which may have changed since (typing, a reload, a
// merge) or been parsed by another chain. A unit is the same block only if a
// unit of the same kind spans the same text at the mapped place; anything
// else is gone, and the move is cancelled. Pure: no DOM, no editor.
import type { BlockModel, Slot, Unit } from '../../markdown/blockModel';

/** A version of the note and its blocks. */
export interface Seen {
  text: string;
  model: BlockModel;
}

/** The two versions differ in one region, found as their common prefix and
 *  suffix: [pre, endA) in the first. */
function changed(a: string, b: string): { pre: number; endA: number } {
  const max = Math.min(a.length, b.length);
  let pre = 0;
  while (pre < max && a.charCodeAt(pre) === b.charCodeAt(pre)) pre++;
  let suf = 0;
  while (suf < max - pre && a.charCodeAt(a.length - 1 - suf) === b.charCodeAt(b.length - 1 - suf)) {
    suf++;
  }
  return { pre, endA: a.length - suf };
}

export interface Matcher {
  /** `id`'s unit in the second version, or null when it's gone. */
  unit(id: number): Unit | null;
  /** `slot` in the second version, or null when what it names is gone. */
  slot(slot: Slot): Slot | null;
}

/** Maps units and slots of `from` to `to`. */
export function matcher(from: Seen, to: Seen): Matcher {
  const same = from.text === to.text;
  const diff = same ? null : changed(from.text, to.text);
  const shift = to.text.length - from.text.length;
  /** Where a range of `from` lies in `to`; null when it meets the change. */
  const place = (a: number, b: number): [number, number] | null => {
    if (!diff || b <= diff.pre) return [a, b];
    if (a >= diff.endA) return [a + shift, b + shift];
    return null;
  };
  const key = (u: Unit, a: number, b: number) => `${u.kind}:${u.scope}:${u.depth}:${a}:${b}`;
  const index = new Map<string, Unit>();
  for (const u of to.model.units) {
    const k = key(u, u.from, u.to);
    if (!index.has(k)) index.set(k, u);
  }
  const unit = (id: number): Unit | null => {
    const u = from.model.units[id];
    const at = u && place(u.from, u.to);
    if (!at) return null;
    const v = index.get(key(u, at[0], at[1]));
    return v && to.text.slice(v.from, v.to) === from.text.slice(u.from, u.to) ? v : null;
  };
  const id = (n: number) => unit(n)?.id ?? null;
  /** A list of `from` in `to`: the list holding any of its items found again. */
  const list = (index: number): number | null => {
    for (const item of from.model.lists[index]?.items ?? []) {
      const v = unit(item);
      if (v && v.container !== null) return v.container;
    }
    return null;
  };

  const slot = (s: Slot): Slot | null => {
    switch (s.scope) {
      case 'top': {
        if (s.before === null) return s;
        const before = id(s.before);
        return before === null ? null : { scope: 'top', before };
      }
      case 'item': {
        const l = list(s.list);
        if (l === null) return null;
        if (s.before === null) return { scope: 'item', list: l, before: null };
        const before = unit(s.before);
        return before && before.container === l
          ? { scope: 'item', list: l, before: before.id }
          : null;
      }
      case 'child': {
        const of = id(s.of);
        return of === null ? null : { scope: 'child', of };
      }
      case 'row': {
        const table = from.model.tables[s.table];
        const t = table ? id(table.unit) : null;
        const k = t === null ? -1 : to.model.tables.findIndex((x) => x.unit === t);
        if (k < 0) return null;
        if (s.before === null) return { scope: 'row', table: k, before: null };
        const before = unit(s.before);
        return before && before.container === k
          ? { scope: 'row', table: k, before: before.id }
          : null;
      }
    }
  };
  return { unit, slot };
}
