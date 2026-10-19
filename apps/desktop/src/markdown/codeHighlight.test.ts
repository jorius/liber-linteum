// A highlighter failure leaves the code plain (final review C1): on an older
// WebKit a grammar's patterns may not compile, and that must never break the
// page that shows the code.
import type { Element, Root } from 'hast';
import { describe, expect, it, vi } from 'vitest';
import { highlightCode } from './codeHighlight';

vi.mock('lowlight', async (importOriginal) => {
  const real = await importOriginal<typeof import('lowlight')>();
  return {
    ...real,
    createLowlight: () => ({
      ...real.createLowlight(),
      highlight: () => {
        throw new SyntaxError('Invalid regular expression: invalid group specifier name');
      },
    }),
  };
});

describe('highlightCode when the highlighter fails', () => {
  it('leaves the code as written and still labels the block', () => {
    const code: Element = {
      type: 'element',
      tagName: 'code',
      properties: { className: ['language-js'] },
      children: [{ type: 'text', value: 'const x = 42;' }],
    };
    const pre: Element = { type: 'element', tagName: 'pre', properties: {}, children: [code] };
    const root: Root = { type: 'root', children: [pre] };
    expect(() => highlightCode(root)).not.toThrow();
    expect(code.children).toEqual([{ type: 'text', value: 'const x = 42;' }]);
    expect(pre.properties.dataLang).toBe('js');
  });
});
