import { diff3Merge } from 'node-diff3';

export type MergeOutcome = { clean: true; text: string } | { clean: false };

/** Lines with their `\n` kept (no lookbehind split: Safari 15 target). */
function lines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', start)) {
    out.push(text.slice(start, i + 1));
    start = i + 1;
  }
  if (start < text.length || !out.length) out.push(text.slice(start));
  return out;
}

/** Line-based 3-way merge (M2a §3.3): `base` is the last text both sides
 *  agreed on, `mine` the editor, `theirs` the file on disk. */
export function merge3(base: string, mine: string, theirs: string): MergeOutcome {
  if (mine === base || mine === theirs) return { clean: true, text: theirs };
  if (theirs === base) return { clean: true, text: mine };
  let text = '';
  for (const region of diff3Merge(lines(mine), lines(base), lines(theirs), {
    excludeFalseConflicts: true,
  })) {
    if (region.conflict) return { clean: false };
    text += (region.ok ?? []).join('');
  }
  return { clean: true, text };
}
