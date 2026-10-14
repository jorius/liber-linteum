// @vitest-environment node
// The app's CSS against the Safari 15 floor (WKWebView on macOS 12). WebKit
// before 15.4 doesn't know `:focus-visible`, and a selector list containing an
// unknown pseudo-class is dropped whole, taking its other selectors with it:
// `.header:hover .addCover, .addCover:focus-visible` hid Add cover for good
// (final review M9).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = fileURLToPath(new URL('../', import.meta.url));

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

/** The selector list of every style rule (at-rule preludes skipped). */
function selectorLists(css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/([^{};]+)\{/g)]
    .map((m) => m[1]!.trim().replace(/\s+/g, ' '))
    .filter((list) => list && !list.startsWith('@'));
}

describe('CSS on the Safari 15 floor', () => {
  it('finds the stylesheets', () => {
    expect(cssFiles(src).length).toBeGreaterThan(5);
  });

  it(':focus-visible never shares a selector list with other selectors', () => {
    const offenders = cssFiles(src).flatMap((file) =>
      selectorLists(readFileSync(file, 'utf8'))
        .filter((list) => list.includes(':focus-visible'))
        .filter((list) => list.split(',').some((s) => !s.includes(':focus-visible')))
        .map((list) => `${file.slice(src.length)}: ${list}`),
    );
    expect(offenders).toEqual([]);
  });
});
