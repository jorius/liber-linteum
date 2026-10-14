// The sweep (M4 §7): every unit of a few representative notes to every slot.
// A move either is refused or keeps every block's text (indentation, `>`
// and list markers aside, by a full parse — independent of the guard's
// windows), and undoing it gives the original back.
import { ChangeSet, Text } from '@codemirror/state';
import type { Node, Parent } from 'mdast';
import { describe, expect, it } from 'vitest';
import { movableBlocks, slotsFor } from './blockModel';
import { applyChanges, moveBlock } from './blockMoves';
import { parsePage } from './parse';

const LEAVES = new Set([
  'paragraph',
  'heading',
  'code',
  'html',
  'thematicBreak',
  'tableRow',
  'yaml',
  'calloutTitle',
]);

/** Every leaf block's text, normalised, sorted; plus `%%` comments. */
function blockTexts(text: string): string[] {
  const page = parsePage(text);
  const out = page.comments.map(([s, e]) => text.slice(s, e));
  const walk = (n: Node) => {
    if (LEAVES.has(n.type)) {
      out.push(
        `${n.type}:${text
          .slice(n.position!.start.offset!, n.position!.end.offset!)
          .split(/\r?\n/)
          .map((l) => l.replace(/^[ \t>]*/, '').trimEnd())
          .join('\n')}`,
      );
      return;
    }
    for (const c of ((n as Parent).children as Node[]) ?? []) walk(c);
  };
  walk(page.tree);
  return out.sort();
}

const NOTES: Record<string, string> = {
  everything: [
    '---',
    'title: x',
    '---',
    '# Title',
    '',
    'Intro *para*.',
    '',
    '## A',
    '',
    'A text.',
    '',
    '- a1',
    '- a2',
    '  - a2x',
    '- [ ] a3',
    '',
    '## B',
    '',
    '1. one',
    '2. two',
    '3. three',
    '',
    '> quote',
    '',
    '| h | i |',
    '|---|---|',
    '| 1 | 2 |',
    '| 3 | 4 |',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '![[img.png]]',
    '',
    '<div>html</div>',
    '',
    '---',
    '',
    'End.',
    '',
  ].join('\n'),
  tight: '# H\nPara\n- l1\n- l2\nTail %%c%%\n\n%% block comment %%\n\nLast\n',
  containers:
    '> [!note] Title\n> body\n\n::::columns\n:::column\nleft\n:::\n:::column\nright\n:::\n::::\n\nAfter\n\n- x\n\n* y\n',
  lists:
    '- a\n\n- b\n  1. b1\n  2. b2\n\n- c\n\nPara\n\n1. one\n2. two\n3. three\n4. four\n5. five\n6. six\n7. seven\n8. eight\n9. nine\n   - nested\n10. ten\n',
};
NOTES.crlf = NOTES.everything.replace(/\n/g, '\r\n');
// Moves the guard must refuse: an indented code block after a list item
// becomes part of it; taking `Para` away merges the two lists.
NOTES.hazards = '- a\n\nPara\n\n- b\n\nP2\n\n    indented code\n\nTail\n';

describe('the sweep (M4 §7)', () => {
  for (const [name, text] of Object.entries(NOTES)) {
    it(`${name}: every unit to every slot keeps the blocks, and undo restores the note`, () => {
      const model = movableBlocks(text, parsePage(text));
      const original = blockTexts(text);
      let tried = 0;
      let refused = 0;
      for (const unit of model.units) {
        for (const lineOnly of unit.kind === 'heading' ? [false, true] : [false]) {
          for (const slot of slotsFor(model, unit, lineOnly)) {
            tried++;
            const r = moveBlock(text, model, unit, slot, { lineOnly });
            expect(r, `${name} ${unit.id} ${JSON.stringify(slot)}`).not.toBeNull();
            if (!r || 'refused' in r) {
              refused++;
              continue;
            }
            const next = applyChanges(text, r.changes);
            const where = `${name}: unit ${unit.id} (${unit.kind}) → ${JSON.stringify(slot)}${lineOnly ? ' line only' : ''}\n${next}`;
            expect(blockTexts(next), where).toEqual(original);
            // The moved block starts where the move says.
            const first = text
              .slice(unit.from, unit.to)
              .split(/\r?\n/)[0]
              .replace(/^[ \t]*(?:[-*+]|\d+[.)])?[ \t]*/, '');
            expect(next.slice(r.at).split(/\r?\n/)[0], where).toContain(first);
            // A valid change set whose inverse gives the note back. (The
            // editor holds LF text; a CRLF file gets its CRLF back on save.)
            if (text.includes('\r')) continue;
            const doc = Text.of(text.split('\n'));
            const set = ChangeSet.of(r.changes, text.length);
            expect(set.apply(doc).toString(), where).toBe(next);
            expect(set.invert(doc).apply(set.apply(doc)).toString(), where).toBe(text);
          }
        }
      }
      expect(tried).toBeGreaterThan(10);
      // Refusals are the exception (merging lists, swallowed blocks).
      if (name === 'hazards') expect(refused).toBeGreaterThan(0);
      else expect(refused).toBe(0);
    });
  }
});
