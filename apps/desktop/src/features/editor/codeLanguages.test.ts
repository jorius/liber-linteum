// The code block language picker (M4b part 2 §2, §10.5; final review I1):
// Enter takes the first match, so what's typed exactly ranks first, and the
// id written into the fence reads back as the language picked.
import type { Element, Root } from 'hast';
import { describe, expect, it } from 'vitest';
import { highlightCode, languageName } from '../../markdown/codeHighlight';
import { filterLanguages, LANGUAGE_CHOICES } from './codeLanguages';

const choice = (name: string) => LANGUAGE_CHOICES.find((l) => l.name === name)!;

describe('filterLanguages', () => {
  it.each([
    ['js', 'JavaScript'],
    ['ts', 'TypeScript'],
    ['xml', 'XML'],
    ['XML', 'XML'],
    ['c', 'C'],
    ['sql', 'SQL'],
    ['sh', 'Shell'],
    ['r', 'R'],
    ['py', 'Python'],
    ['python', 'Python'],
    ['json', 'JSON'],
    ['java', 'Java'],
    ['ms sql', 'MS SQL'],
  ])('"%s" puts %s first', (query, name) => {
    expect(filterLanguages(query)[0]?.name).toBe(name);
  });

  it('ranks exact matches, then prefixes, then the rest of the matches', () => {
    // Prefixes (alphabetical), then names that only hold it.
    expect(filterLanguages('sq').map((l) => l.name)).toEqual([
      'SQL',
      'SQLite',
      'Squirrel',
      'MariaDB SQL',
      'MS SQL',
      'MySQL',
      'PLSQL',
      'PostgreSQL',
    ]);
    expect(filterLanguages('java').map((l) => l.name)).toEqual(['Java', 'JavaScript']);
    // An alias prefix counts like a name prefix ("coffee" is an alias).
    expect(filterLanguages('coffee').map((l) => l.name)).toEqual(['CoffeeScript']);
    expect(filterLanguages('type').map((l) => l.name)[0]).toBe('TypeScript');
  });

  it('keeps every language containing the query', () => {
    expect(filterLanguages('script').map((l) => l.name)).toEqual(
      expect.arrayContaining(['JavaScript', 'TypeScript', 'CoffeeScript', 'VBScript']),
    );
  });
});

describe('fence ids', () => {
  it('never hold white space', () => {
    expect(LANGUAGE_CHOICES.filter((l) => /\s/.test(l.id) || !l.id)).toEqual([]);
  });

  it.each([
    ['XML', 'xml'],
    ['JavaScript', 'js'],
    ['TypeScript', 'ts'],
    ['Python', 'python'],
    ['C++', 'cpp'],
    ['C#', 'cs'],
    ['Shell', 'sh'],
    ['MS SQL', 'mssql'],
    ['MariaDB SQL', 'mariadbsql'],
    ['Angular Template', 'angulartemplate'],
  ])('%s is written %s', (name, id) => {
    expect(choice(name).id).toBe(id);
  });

  it('read back as the language picked (the badge names it)', () => {
    const wrong = LANGUAGE_CHOICES.filter((l) => languageName(l.id) !== l.name).map(
      (l) => `${l.name} → ${l.id} → ${languageName(l.id)}`,
    );
    expect(wrong).toEqual([]);
  });

  it('a multi-word language written without spaces is still highlighted', () => {
    const code: Element = {
      type: 'element',
      tagName: 'code',
      properties: { className: ['language-mssql'] },
      children: [{ type: 'text', value: 'SELECT 1 FROM t' }],
    };
    const root: Root = {
      type: 'root',
      children: [{ type: 'element', tagName: 'pre', properties: {}, children: [code] }],
    };
    highlightCode(root);
    expect(code.children.some((c) => c.type === 'element')).toBe(true);
  });
});
