// @vitest-environment node
// Parity with the Rust indexer (M2a spec §2.6): the same fixtures are asserted
// by crates/liber-markdown/tests/parity.rs.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePage } from './parse';

const dir = fileURLToPath(new URL('../../../../fixtures/markdown/', import.meta.url));
const pages = readdirSync(dir).filter((f) => f.endsWith('.md'));

describe('parity fixtures (TS model ↔ liber-markdown)', () => {
  it('has fixtures', () => expect(pages.length).toBeGreaterThan(0));
  it.each(pages)('%s', (file) => {
    const src = readFileSync(dir + file, 'utf8');
    const expected = JSON.parse(
      readFileSync(dir + file.replace(/\.md$/, '.expected.json'), 'utf8'),
    );
    const p = parsePage(src);
    expect(
      p.links.map(({ kind, target, heading, alias }) => ({ kind, target, heading, alias })),
    ).toEqual(expected.links);
    expect(p.tags).toEqual(expected.tags);
  });
});
