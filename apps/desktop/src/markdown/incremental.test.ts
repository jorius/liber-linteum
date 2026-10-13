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

function note(lines: number): string {
  let src = '# Big note\n\n';
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
const NONLOCAL_PIECES = ['`', '```', '%%', '<b>', '[x]: y', ':::'];

/** Applies `steps` seeded random edits; after each, the incremental model must
 *  equal a full parse. Returns how often untouched blocks were reused. */
function fuzz(seed: number, pieces: string[], steps: number): number {
  const next = rng(seed);
  let text = note(60);
  let page = parsePage(text);
  let reused = 0;
  for (let step = 0; step < steps; step++) {
    const firstBlock = page.tree.children[0];
    const at = Math.floor(next() * (text.length + 1));
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

  it('re-parses one typed character in a 5,000-line note in under 50 ms', () => {
    const text = note(5000);
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
  }, 30_000); // two full parses + a deep compare of a 5,000-line tree

  it('returns the previous model for identical text', () => {
    const page = parsePage('# A\n');
    expect(reparse(page, '# A\n', '# A\n')).toBe(page);
  });
});
