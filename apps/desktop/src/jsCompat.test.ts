// @vitest-environment node
// The app's TypeScript against the Safari 15 floor (WKWebView on macOS 12;
// M4 final review M7). The build lowers syntax to `safari15`, but it doesn't
// polyfill library calls, and a regex lookbehind can't be lowered: on Safari
// 15.0–15.3 these throw, or fail to parse, at run time. Tests run in Node and
// may use them.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = fileURLToPath(new URL('./', import.meta.url));

/** What Safari 15.0 lacks, and the Safari version that brought it. */
const NEWER: [RegExp, string][] = [
  [/\.at\(/, 'Array/String.prototype.at (15.4)'],
  [/\bObject\.hasOwn\(/, 'Object.hasOwn (15.4)'],
  [/\bstructuredClone\(/, 'structuredClone (15.4)'],
  [/\.findLast(Index)?\(/, 'Array.prototype.findLast (15.4)'],
  [/\.randomUUID\(/, 'crypto.randomUUID (15.4)'],
  [/\.showModal\(/, 'HTMLDialogElement.showModal (15.4)'],
  [/\.(toSorted|toReversed|toSpliced)\(/, 'change-array-by-copy (16)'],
  [/\bArray\.fromAsync\(/, 'Array.fromAsync (16.4)'],
  [/\(\?<[=!]/, 'regex lookbehind (16.4)'],
  [/\b(Object|Map)\.groupBy\(/, 'Object.groupBy (17.4)'],
  [/\bPromise\.withResolvers\(/, 'Promise.withResolvers (17.4)'],
];

/** Files whose offenders are being fixed elsewhere. Each must still have one
 *  (so the list empties as they're fixed). */
const PENDING = new Set(['markdown/incremental.ts']);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test' ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** `file: line` for every use of an API Safari 15.0 lacks (comments aside). */
function offenders(file: string): string[] {
  const name = file.slice(src.length);
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .flatMap((line) =>
      NEWER.filter(([re]) => re.test(line)).map(([, what]) => `${name}: ${what}: ${line.trim()}`),
    );
}

describe('TypeScript on the Safari 15 floor', () => {
  it('finds the sources', () => {
    expect(sources(src).length).toBeGreaterThan(50);
  });

  it('uses no API newer than Safari 15.0', () => {
    const found = sources(src)
      .filter((file) => !PENDING.has(file.slice(src.length)))
      .flatMap(offenders);
    expect(found).toEqual([]);
  });

  it('the pending list holds only files that still need it', () => {
    for (const name of PENDING) expect(offenders(join(src, name)), name).not.toEqual([]);
  });
});
