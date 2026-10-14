// @vitest-environment node
// The move path runs in WKWebView from Safari 15.0 (macOS 12): it uses no
// API Safari added later (final review M7): `Array.prototype.at`,
// `findLast`, `Object.hasOwn`, `structuredClone` (15.4), `toSorted` and
// friends (16), `Object.groupBy` (17.4).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MOVE_PATH = [
  './blockModel.ts',
  './blockMoves.ts',
  './incremental.ts',
  './parse.ts',
  './blocks.ts',
  './inline.ts',
  './frontmatter.ts',
  './locate.ts',
  './walk.ts',
  './wikilink.ts',
  './decode.ts',
  '../features/editor/blockCommands.ts',
];
const NEWER =
  /\.at\(|\.findLast(?:Index)?\(|Object\.hasOwn\(|structuredClone\(|\.to(?:Sorted|Reversed|Spliced)\(|Object\.groupBy\(/;

describe('the move path runs on Safari 15.0 (final review M7)', () => {
  it.each(MOVE_PATH)('%s uses no newer API', (file) => {
    const lines = readFileSync(new URL(file, import.meta.url), 'utf8').split('\n');
    expect(lines.filter((l) => NEWER.test(l))).toEqual([]);
  });
});
