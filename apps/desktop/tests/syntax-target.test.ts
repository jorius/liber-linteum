// @vitest-environment node
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd });

async function ruleIds(code: string) {
  const [result] = await eslint.lintText(code, { filePath: 'src/features/example.ts' });
  return result.messages.map((m) => m.ruleId);
}

describe('build target (Safari 15 / WKWebView on macOS 12)', () => {
  it.each(['export const a = /(?<=x)y/;', 'export const b = /(?<!\\\\)\\|/;'])(
    'rejects regex lookbehind (Safari 16.4+): %s',
    async (code) => {
      expect(await ruleIds(code)).toContain('no-restricted-syntax');
    },
  );

  it('allows lookahead and named groups', async () => {
    expect(await ruleIds('export const c = /x(?=y)(?<name>z)/;')).toEqual([]);
  });
});
