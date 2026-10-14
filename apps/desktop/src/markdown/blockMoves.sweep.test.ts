// The sweep (M4 §7): every unit of a few representative notes to every slot.
// A move either is refused or keeps every block's text (indentation, `>`
// and list markers aside, by a full parse — independent of the guard's
// windows), and undoing it gives the original back.
import { ChangeSet, Text } from '@codemirror/state';
import type { Node, Parent } from 'mdast';
import { describe, expect, it } from 'vitest';
import { movableBlocks, slotsFor, type BlockModel, type Slot } from './blockModel';
import { applyChanges, moveBlock, planMove, type Move } from './blockMoves';
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
// Review focus: setext headings, `)` and 0-based ordered lists, a task list.
NOTES.variants =
  'Title\n=====\n\nIntro.\n\nSub\n---\n\n0) zero\n1) one\n2) two\n\n- [ ] todo\n- [x] done\n\nEnd.\n';
// Moves the guard must refuse: an indented code block after a list item
// becomes part of it; taking `Para` away merges the two lists.
NOTES.hazards = '- a\n\nPara\n\n- b\n\nP2\n\n    indented code\n\nTail\n';
// Final review C1: a move leaving a `---` rule first opens front matter.
NOTES.frontRule = 'Intro\n\n---\n\nA\n\nB\n\nC\n\n---\n\nD\n';
/** Notes some of whose moves the guard must refuse. */
const REFUSING = new Set(['hazards', 'frontRule']);

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
      if (REFUSING.has(name)) expect(refused).toBeGreaterThan(0);
      else expect(refused).toBe(0);
    });
  }
});

// ---- the fuzz (final review) ------------------------------------------------
// Random notes × random moves, by oracles that don't use the guard's windows:
// the same lines (indentation, `>` and list markers aside); a full parse's
// blocks, containers, task states and comments; every list item under the
// same parent item; the same front matter, and no `---` line first that
// wasn't; a change set that applies and inverts; the moved block at `at`.
// Each generator adds hazards the final review found.

type Rand = () => number;
function rng(seed: number): Rand {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

/** Notes made of random blocks; `word()` gives each a distinct word. */
function writer(r: Rand) {
  let n = 0;
  const word = () => `${pick(r, ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta'])}${n++}`;
  const inline = () =>
    pick(r, [
      word,
      () => `*${word()}*`,
      () => `[[${word()}]]`,
      () => `#tag${n++}`,
      () => `%%c${n++}%%`,
      () => `\`code${n++}\``,
      () => `a \\| b${n++}`,
    ])();
  const sentence = () => Array.from({ length: 1 + Math.floor(r() * 3) }, inline).join(' ');
  const list = (depth: number, indent: string): string[] => {
    const ordered = r() < 0.4;
    const delim = pick(r, ['.', ')']);
    const bullet = pick(r, ['-', '*', '+']);
    const start = pick(r, [0, 1, 1, 3, 9]);
    const numbering = pick(r, ['seq', 'seq', 'same', 'random']);
    const loose = r() < 0.25;
    const out: string[] = [];
    const count = 1 + Math.floor(r() * 4);
    for (let k = 0; k < count; k++) {
      const num =
        numbering === 'seq' ? start + k : numbering === 'same' ? start : Math.floor(r() * 12);
      const marker = ordered ? `${num}${delim}` : bullet;
      const task = r() < 0.2 ? pick(r, ['[ ] ', '[x] ']) : '';
      out.push(`${indent}${marker} ${task}${sentence()}`);
      const col = indent + ' '.repeat(marker.length + 1);
      const extra = r();
      if (extra < 0.15) out.push(`${col}${sentence()}`);
      else if (extra < 0.2)
        out.push(sentence()); // a lazy continuation
      else if (extra < 0.27) out.push('', `${col}${sentence()}`);
      else if (extra < 0.32) out.push(`${col}\`\`\``, `${col}- not an item`, '', `${col}\`\`\``);
      if (depth < 2 && r() < 0.3) out.push(...list(depth + 1, col));
      if (loose && k < count - 1) out.push('');
    }
    return out;
  };
  const ordinary = (): string[] =>
    pick(r, [
      () => [sentence()],
      () => [sentence(), sentence()],
      () => [`${'#'.repeat(1 + Math.floor(r() * 3))} ${word()}`],
      () => [word(), pick(r, ['===', '---'])],
      () => [pick(r, ['***', '___', '- - -'])],
      () => list(0, ''),
      () => list(0, ''),
      () => ['```js', '- item in code', '# heading in code', '---', '```'],
      () => ['    indented code', '    more code'],
      () => [`> ${sentence()}`, `> ${sentence()}`],
      () => [`> ${word()}`, '>', `> > nested ${word()}`],
      () => [`> - ${word()}`, `> - ${word()}`],
      () => [`> [!note] ${word()}`, `> ${sentence()}`],
      () => ['| h | i |', '|---|---|', `| ${word()} | a \\| b |`, `| ${word()} | 2 |`],
      () => ['<div>', word(), '</div>'],
      () => [`%% block ${word()} %%`],
      () => [`[^${n++}]: ${word()}`, `    ${word()}`],
      () => [`![[${word()}.png]]`],
      () => ['::::columns', ':::column', word(), ':::', ':::column', word(), ':::', '::::'],
    ])();
  return { word, sentence, list, ordinary };
}

type Writer = ReturnType<typeof writer>;

interface Generator {
  /** A block, or null for an ordinary one. */
  block(r: Rand, w: Writer): string[] | null;
  /** Front matter or a byte-order mark before the blocks. */
  head?(r: Rand, w: Writer): string;
  /** No refusal of a move that would have kept the note, or of an item
   *  reordered in its own list. */
  strict?: boolean;
}

const GENERATORS: Record<string, Generator> = {
  ordinary: { block: () => null },
  // C1: rules that could open or close front matter, and YAML-like lines.
  frontRules: {
    block: (r, w) =>
      r() < 0.4
        ? pick(r, [['---'], ['---  '], [`${w.word()}: ${w.word()}`], ['...'], [w.word(), '---']])
        : null,
  },
  // M1: `%%` comments spanning blocks, and `%%` that pair with nothing.
  comments: {
    block: (r, w) =>
      r() < 0.4
        ? pick(r, [
            [`${w.word()} %%`],
            [`%% ${w.word()}`],
            [`%%c%% ${w.word()}`],
            [`${w.word()} 50%% off`],
            ['%%', w.word(), '', w.word(), '%%'],
          ])
        : null,
  },
  // I4: a byte-order mark first (files from Windows tools), front matter or not.
  bom: {
    block: () => null,
    head: (r, w) => `\uFEFF${r() < 0.2 ? `---\ntitle: ${w.word()}\n---\n` : ''}`,
  },
  // M4: list items holding code with blank and whitespace-only lines (their
  // markers growing 9. → 10.), code blocks, tables. Every move must go.
  codeLines: {
    strict: true,
    block: (r, w) =>
      pick(r, [
        () => {
          const out: string[] = [];
          const ordered = r() < 0.5;
          for (let k = 0; k < 2 + Math.floor(r() * 3); k++) {
            const marker = ordered ? `${k + 8}.` : '-';
            const col = ' '.repeat(marker.length + 1);
            out.push(`${marker} ${w.word()}`);
            if (r() < 0.6) {
              const gap = pick(r, ['', ' ', `${col}  `, `${col}    `]);
              out.push(
                `${col}\`\`\``,
                `${col}${w.word()}`,
                gap,
                `${col}${w.word()}`,
                `${col}\`\`\``,
              );
            }
          }
          return out;
        },
        () => ['```', w.word(), '    ', '', w.word(), '```'],
        () => ['| h | i |', '|---|---|', `| ${w.word()} | 1 |`, `| ${w.word()} | 2 |`],
        () => [w.sentence()],
      ])(),
  },
  // I3: top-level lists indented 2 or 3 spaces (pasted content), which nest
  // under a list moved in front of them.
  indentedLists: {
    block: (r, w) =>
      r() < 0.35
        ? w.list(0, pick(r, ['  ', '   '])).concat(r() < 0.5 ? [`- ${w.word()}`] : [])
        : null,
  },
};

function note(r: Rand, gen: Generator): string {
  const w = writer(r);
  const blocks = Array.from(
    { length: 2 + Math.floor(r() * 7) },
    () => gen.block(r, w) ?? w.ordinary(),
  );
  let text = gen.head ? gen.head(r, w) : r() < 0.2 ? `---\ntitle: ${w.word()}\n---\n` : '';
  blocks.forEach((b, i) => {
    // (A strict note's blocks stand apart: no lazy line joins an item.)
    if (i > 0) text += gen.strict ? '\n\n' : pick(r, ['\n\n', '\n\n', '\n', '\n\n\n']);
    text += b.join('\n');
  });
  return text + (r() < 0.8 ? '\n' : '');
}

/** Lines without indentation, `>` and list markers; blank ones dropped. */
const contentLines = (t: string) =>
  t
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => {
      let x = l.trimEnd();
      for (;;) {
        const y = x
          .replace(/^[ \t]*>?[ \t]*/, '')
          .replace(/^(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/, '');
        if (y === x) return x;
        x = y;
      }
    })
    .filter(Boolean)
    .sort();

const CONTAINER: Record<string, string> = {
  blockquote: 'Q',
  callout: 'C',
  columns: 'K',
  column: 'k',
  table: 'T',
  footnoteDefinition: 'F',
};
const LEAF = new Set([...LEAVES, 'definition', 'math']);

/** The first line of the item starting at `from`, marker and checkbox aside. */
const itemKey = (src: string, from: number) =>
  src
    .slice(from, src.indexOf('\n', from) < 0 ? src.length : src.indexOf('\n', from))
    .replace(/^[ \t>]*(?:[-*+]|\d{1,9}[.)])[ \t]*(?:\[[ xX]\][ \t]+)?/, '')
    .trim();

/** A full parse: every leaf with its containers, task states, comments; and
 *  each list item's parent item (by first line). */
function structure(src: string) {
  const page = parsePage(src);
  const sig: string[] = page.comments.map(([s, e]) => `%${src.slice(s, e)}`);
  const parents = new Map<string, string>();
  /** Each list's items (keys): which lists merge or split. */
  const lists: string[][] = [];
  const walk = (n: Node, flags: string, parent: string) => {
    if (n.type === 'list') {
      lists.push(
        ((n as Parent).children as Node[]).map((c) => itemKey(src, c.position!.start.offset!)),
      );
    }
    if (n.type === 'listItem') {
      const key = itemKey(src, n.position!.start.offset!);
      sig.push(`item:${flags}:${String((n as { checked?: boolean | null }).checked ?? '')}`);
      parents.set(key, parents.has(key) ? '<dup>' : parent);
      parent = key;
    }
    if (LEAF.has(n.type)) {
      const x = n as { depth?: number; lang?: string | null; value?: string };
      const body =
        n.type === 'code'
          ? `${x.lang ?? ''}|${x.value}`
          : src
              .slice(n.position!.start.offset!, n.position!.end.offset!)
              .split(/\r?\n/)
              .map((l) => l.replace(/^[ \t>]*/, '').trimEnd())
              .join('\n');
      sig.push(`${flags}:${n.type}:${x.depth ?? ''}:${body}`);
      return;
    }
    const inList = n.type === 'list' || n.type === 'listItem';
    const next = inList
      ? flags.endsWith('L')
        ? flags
        : `${flags}L`
      : flags + (CONTAINER[n.type] ?? '');
    for (const c of ((n as Parent).children as Node[]) ?? []) walk(c, next, parent);
  };
  for (const n of page.tree.children) {
    if (n.type !== 'yaml' && n.type !== 'list') sig.push(`top:${n.type}`);
    walk(n, '', '');
  }
  const fm = page.frontmatter;
  return { sig: sig.sort(), parents, lists, frontmatter: fm ? src.slice(...fm.range) : null };
}

/** The lists' item sets, `moved` aside (it may join or leave one). */
const listSets = (lists: string[][], moved: string | null) =>
  lists
    .map((l) =>
      l
        .filter((k) => k !== moved)
        .sort()
        .join('\u0001'),
    )
    .filter(Boolean)
    .sort();

const leadRule = (t: string) => /^\uFEFF?---[ \t]*\r?\n/.test(t);

/** The parent item (its key, '' for none) an item moved to `slot` gets. */
function slotParent(text: string, model: BlockModel, slot: Slot): string {
  if (slot.scope === 'child') return itemKey(text, model.units[slot.of].from);
  const parent = slot.scope === 'item' ? model.lists[slot.list].parentItem : null;
  return parent === null ? '' : itemKey(text, model.units[parent].from);
}

/** Every problem `count` random notes' moves show; [] when all hold. */
function fuzz(seed: number, gen: Generator, count: number) {
  const r = rng(seed);
  const problems: string[] = [];
  let tried = 0;
  for (let d = 0; d < count && problems.length < 5; d++) {
    const text = note(r, gen);
    const model = movableBlocks(text, parsePage(text));
    const lines = contentLines(text);
    const before = structure(text);
    for (const unit of model.units) {
      const moved = unit.scope === 'item' ? itemKey(text, unit.from) : null;
      for (const lineOnly of unit.kind === 'heading' ? [false, true] : [false]) {
        const slots = slotsFor(model, unit, lineOnly);
        for (const slot of slots.length > 6 ? slots.filter(() => r() < 6 / slots.length) : slots) {
          tried++;
          const where = `seed ${seed} note ${d}: ${unit.kind} ${JSON.stringify(text.slice(unit.from, unit.to))} → ${JSON.stringify(slot)}${lineOnly ? ' line only' : ''}\n${JSON.stringify(text)}`;
          let res;
          try {
            res = moveBlock(text, model, unit, slot, { lineOnly });
          } catch (e) {
            problems.push(`THROWS ${String(e)} ${where}`);
            continue;
          }
          if (!res) problems.push(`NULL ${where}`);
          if (!res) continue;
          /** What's wrong with the note after `move`. */
          const check = (move: Move): string[] => {
            const next = applyChanges(text, move.changes);
            const after = structure(next);
            const found: string[] = [];
            if (JSON.stringify(contentLines(next)) !== JSON.stringify(lines)) found.push('CONTENT');
            if (JSON.stringify(after.sig) !== JSON.stringify(before.sig)) found.push('STRUCTURE');
            if (after.frontmatter !== before.frontmatter) found.push('FRONTMATTER');
            if (leadRule(next) && !leadRule(text)) found.push('LEADRULE');
            const sets = (lists: string[][]) => JSON.stringify(listSets(lists, moved));
            if (sets(after.lists) !== sets(before.lists)) found.push('LISTS');
            // Every item keeps its parent item; the moved one takes its slot's.
            for (const [key, parent] of before.parents) {
              const now = after.parents.get(key);
              if (parent === '<dup>' || now === '<dup>') continue;
              const want = key === moved ? slotParent(text, model, slot) : parent;
              if (now !== want) {
                found.push(`NESTING ${JSON.stringify(key)} under ${JSON.stringify(now)}`);
                break;
              }
            }
            const first = text
              .slice(unit.from, unit.to)
              .replace(/^\uFEFF/, '')
              .split(/\r?\n/)[0]
              .replace(/^[ \t]*(?:[-*+]|\d+[.)])?[ \t]*/, '');
            if (!next.slice(move.at).split(/\r?\n/)[0].includes(first)) found.push('PLACEMENT');
            if (!text.includes('\r')) {
              const doc = Text.of(text.split('\n'));
              const set = ChangeSet.of(move.changes, text.length);
              if (set.apply(doc).toString() !== next) found.push('CHANGESET');
              else if (set.invert(doc).apply(set.apply(doc)).toString() !== text)
                found.push('INVERSE');
            }
            return found.length ? [`${found.join(',')} ${where}\n→ ${JSON.stringify(next)}`] : [];
          };
          if (!('refused' in res)) problems.push(...check(res));
          else if (gen.strict) {
            // An item reordered in its own list touches nothing else.
            if (slot.scope === 'item' && slot.list === unit.container)
              problems.push(`REFUSED IN ITS LIST ${where}`);
            const planned = planMove(text, model, unit, slot, { lineOnly });
            if (planned && !check(planned).length) problems.push(`NEEDLESS REFUSAL ${where}`);
          }
        }
      }
    }
  }
  return { problems, tried };
}

describe('the sweep’s fuzz: random notes × random moves (final review)', () => {
  // [generator, seed, notes]: a few seconds in all; the seeds are ones that
  // found the generator's bug before its fix.
  it.each([
    ['ordinary', 1, 20],
    ['frontRules', 3, 25],
    ['indentedLists', 8, 8],
    ['bom', 5, 20],
    ['comments', 6, 60],
    ['codeLines', 7, 30],
  ] as const)(
    '%s notes (seed %i, %i notes): every accepted move keeps the note',
    (name, seed, notes) => {
      const { problems, tried } = fuzz(seed, GENERATORS[name], notes);
      expect(problems).toEqual([]);
      expect(tried).toBeGreaterThan(150);
    },
    60_000,
  );
});
