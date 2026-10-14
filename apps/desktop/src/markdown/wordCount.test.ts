import { describe, expect, it } from 'vitest';
import { parsePage } from './parse';
import { countText, proseOf, readingMinutes } from './wordCount';

const count = (text: string, from?: number, to?: number) =>
  countText(proseOf(parsePage(text), text, from, to));

describe('word count (M4b part 2 §5)', () => {
  it('counts prose, not Markdown syntax, URLs, front matter or comments', () => {
    const text = [
      '---',
      'title: Lots of words here',
      '---',
      '# The **title**',
      '',
      'See [the docs](https://example.com/a/b) and [[Other page|that page]] or [[Plain]].',
      '%% a hidden comment of six words %%',
      '- one *two* `three`',
      '',
      '![alt text](pic.png) #tag',
    ].join('\n');
    // The title (2) · See the docs and that page or Plain (8) · one two three
    // (3) · alt text tag (3).
    expect(count(text).words).toBe(16);
  });

  it('counts code and maths blocks as text, joined words as one', () => {
    // const, x, 1 (a lone `=` isn't a word).
    expect(count('```js\nconst x = 1;\n```\n').words).toBe(3);
    expect(count('$$\na + b\n$$\n').words).toBe(2);
    expect(count('foo**bar** baz').words).toBe(2);
  });

  it('counts each CJK character as a word', () => {
    expect(count('日本語のテキスト and two').words).toBe(10);
  });

  it('gives characters with and without spaces', () => {
    expect(count('# Hi there\n\nAll  good.\n')).toEqual({ words: 4, chars: 18, bare: 15 });
  });

  it('counts only a selection when given one', () => {
    const text = '# Title\n\nOne two three four.\n';
    const from = text.indexOf('two');
    expect(count(text, from, from + 'two three'.length).words).toBe(2);
    // Partly selected words count once.
    expect(count(text, from + 1, from + 5).words).toBe(2);
  });

  it('reads at 230 words a minute', () => {
    expect(readingMinutes(0)).toBe(0);
    expect(readingMinutes(1)).toBe(1);
    expect(readingMinutes(1234)).toBe(6);
  });
});
