// @vitest-environment node
// Encryption UX round §5: one chip (Beta, the recent list's Encrypted) with one
// shape everywhere; its geometry in a real engine is checked by e2e.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = new URL('..', import.meta.url).pathname;
const base = readFileSync(new URL('./base.css', import.meta.url), 'utf8');

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return files(path, ext);
    return ext.test(e.name) && !/\.test\./.test(e.name) ? [path] : [];
  });
}

describe('the chip', () => {
  const rule = /\.liber-chip\s*\{([^}]*)\}/.exec(base)?.[1] ?? '';

  it('is inline-flex, 18 px high, 0 7 px padding, 8 px from the word before it, accent on accent-soft', () => {
    expect(rule).toMatch(/display:\s*inline-flex/);
    expect(rule).toMatch(/align-items:\s*center/);
    expect(rule).toMatch(/vertical-align:\s*middle/);
    expect(rule).toMatch(/height:\s*18px/);
    expect(rule).toMatch(/padding:\s*0 7px/);
    expect(rule).toMatch(/margin-left:\s*8px/);
    expect(rule).toMatch(/color:\s*var\(--color-accent\)/);
    expect(rule).toMatch(/background:\s*var\(--color-accent-soft\)/);
    // A ring: the pill still reads on an accent-soft row or card (Safari 15: no color-mix).
    expect(rule).toMatch(/box-shadow:\s*inset 0 0 0 1px currentColor/);
  });

  it('is never pushed to the far edge (no margin-left: auto on any chip)', () => {
    expect(base).not.toMatch(/\.liber-chip[^{]*\{[^}]*margin-left:\s*auto/);
  });

  it('every Beta label uses it: no module keeps its own beta pill', () => {
    for (const f of files(src, /\.module\.css$/)) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/\.beta(Pill)?\b/);
    }
    for (const f of files(src, /\.tsx$/)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(
        /<span className=\{?([^>]*)>\{t\('(?:encryption|unlock)\.beta'\)/g,
      )) {
        expect(m[1], f).toContain('liber-chip');
      }
    }
  });
});
