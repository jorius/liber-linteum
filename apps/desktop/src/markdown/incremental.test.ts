import { describe, expect, it } from 'vitest';
import { reparse } from './incremental';
import { parsePage } from './parse';

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const block = (i: number) =>
  `## Section ${i}\n\nSome *text* with **bold**, a [[Link ${i}|alias]] and #tag${i % 7} plus ==mark==.\n\n` +
  `- [ ] task ${i}\n- item with [md](page${i}.md) and 😀 emoji\n\n> [!note] Callout ${i}\n> body\n\n` +
  `| a | b |\n|---|---|\n| ${i} | x |\n\n1. one\n2. two\n\n`;

/** Frontmatter, then a comment, as most real pages start (I2). */
const HEAD = '---\ntags: [a, b]\ntitle: Big\n---\n%% todo: tidy up %%\n\n';

function note(lines: number, head = ''): string {
  let src = head + '# Big note\n\n';
  for (let i = 0; src.split('\n').length < lines; i++) src += block(i);
  return src;
}

/** Typing-like edits; `NONLOCAL_PIECES` add constructs that force a full parse. */
const LOCAL_PIECES = [
  'a',
  ' ',
  '\n',
  '\n\n',
  '#',
  '# ',
  '*',
  '**',
  '- ',
  '1. ',
  '[[',
  ']]',
  '==',
  '>',
  '|',
  '---',
  '😀',
  '\t',
  '  - ',
  '[!tip]',
];
/** References resolve against definitions anywhere on the page (I3). */
const REFERENCE_PIECES = [
  '[ref]',
  '[^1]',
  '[Ref][]',
  '[x][ref]',
  '[ref]: https://e.x',
  '[^1]: Note.',
];
const DEFS = 'See [ref] and a note[^1].\n\n[ref]: https://e.x\n\n[^1]: A footnote.\n\n';
const NONLOCAL_PIECES = ['`', '```', '%%', '<b>', '[x]: y', ':::'];

/** Applies `steps` seeded random edits; after each, the incremental model must
 *  equal a full parse. Returns how often untouched blocks were reused. */
function fuzz(seed: number, pieces: string[], steps: number, head = '', skipHead = false): number {
  const next = rng(seed);
  let text = note(60, head);
  const lo = skipHead ? head.length : 0;
  let page = parsePage(text);
  let reused = 0;
  for (let step = 0; step < steps; step++) {
    const firstBlock = page.tree.children[0];
    const at = lo + Math.floor(next() * (text.length - lo + 1));
    const edited =
      next() < 0.6
        ? text.slice(0, at) + pieces[Math.floor(next() * pieces.length)] + text.slice(at)
        : text.slice(0, at) + text.slice(Math.min(text.length, at + 1 + Math.floor(next() * 6)));
    page = reparse(page, text, edited);
    text = edited;
    expect(page, `seed ${seed} step ${step}`).toEqual(parsePage(text));
    if (page.tree.children[0] === firstBlock) reused++;
  }
  return reused;
}

describe('incremental re-parse (M2a §7: typing in a 5,000-line note)', () => {
  it('typing-like edits: equals the full parse, and mostly re-parses locally', () => {
    expect(fuzz(42, LOCAL_PIECES, 200)).toBeGreaterThan(130);
  }, 60_000);

  it('edits adding fences, HTML, comments or definitions still equal the full parse', () => {
    fuzz(7, [...LOCAL_PIECES, ...NONLOCAL_PIECES], 200);
  }, 60_000);

  it('with frontmatter and a comment: equals the full parse, and mostly re-parses locally', () => {
    // Edits anywhere, frontmatter and comment included (they may break it)…
    fuzz(11, [...LOCAL_PIECES, ...NONLOCAL_PIECES], 200, HEAD);
    // …and below them: the frontmatter stays a fixed block, so no full parse.
    // Same order as the plain fuzz (seed 42: 139 plain, 122 here; the rest are
    // edits that legitimately need a full parse).
    expect(fuzz(42, LOCAL_PIECES, 200, HEAD, true)).toBeGreaterThan(110);
  }, 60_000);

  it('reference links and footnotes resolve as in the full parse', () => {
    const text = 'Intro.\n\nType here.\n\nMiddle.\n\nEnd.\n\n[ref]: https://e.x\n\n[^1]: Note.\n';
    const typed = text.replace('Type here.', 'Type [ref] and[^1] here.');
    const page = reparse(parsePage(text), text, typed);
    expect(page).toEqual(parsePage(typed));
    // …and definitions added or removed in another block.
    const noDefs = typed.replace('[ref]: https://e.x\n\n', '');
    expect(reparse(parsePage(typed), typed, noDefs)).toEqual(parsePage(noDefs));
  });

  it('edits adding references and definitions still equal the full parse', () => {
    fuzz(21, [...LOCAL_PIECES, ...REFERENCE_PIECES], 200);
    fuzz(22, [...LOCAL_PIECES, ...REFERENCE_PIECES], 200, DEFS);
  }, 60_000);

  it.each([
    ['plain', ''],
    ['with frontmatter and a %% comment', HEAD],
  ])(
    're-parses one typed character in a 5,000-line note (%s) in under 50 ms',
    (_, head) => {
      const text = note(5000, head);
      let page = parsePage(text);
      let current = text;
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const at = current.indexOf('Some *text*', Math.floor(current.length / 2) + i * 997);
        const typed = current.slice(0, at) + 'x' + current.slice(at);
        const t0 = performance.now();
        page = reparse(page, current, typed);
        times.push(performance.now() - t0);
        current = typed;
      }
      expect(page).toEqual(parsePage(current));
      expect(Math.min(...times)).toBeLessThan(50);
    },
    30_000,
  ); // two full parses + a deep compare of a 5,000-line tree

  it('returns the previous model for identical text', () => {
    const page = parsePage('# A\n');
    expect(reparse(page, '# A\n', '# A\n')).toBe(page);
  });
});
