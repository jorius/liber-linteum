// @vitest-environment node
// Round 3 §3.3: one field size across the app. Text, number and search
// inputs, selects and dialogs' path values share one class, so a settings
// select and the text field under it can't drift apart again (a native
// WebKit select was 22 px beside a 31 px input).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = new URL('..', import.meta.url).pathname;
const css = readFileSync(new URL('./fields.css', import.meta.url), 'utf8');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return files(path);
    return /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [path] : [];
  });
}

/** Each `<input …>` / `<select …>` opening tag: its attributes, read to the
 *  `>` outside braces (an arrow function's `=>` sits inside them). */
function tags(text: string): { at: number; attrs: string }[] {
  return [...text.matchAll(/<(?:input|select)\b/g)].map((m) => {
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    return { at: m.index, attrs: text.slice(m.index + m[0].length, i) };
  });
}

/** Fields that aren't form fields: they sit inline in what they edit, or in
 *  a bar with its own control size. */
const EXEMPT = new Set([
  'features/page/PageTitle.tsx', // the heading itself
  'features/page/PageSubtitle.tsx',
  'features/explorer/TreeRow.tsx', // renaming in the row
  'features/search/SearchDialog.tsx', // the search bar heading the dialog
  'features/editor/Toolbar.tsx', // a 30 px toolbar control, like its buttons
]);
/** Settings' menu search: a search bar in the sidebar-coloured menu. */
const EXEMPT_ATTRS = /settings\.search/;

describe('one field size (round 3 §3.3)', () => {
  it('defines the field from the tokens, as tall as a button, with a drawn select arrow', () => {
    const rule = (sel: string) =>
      new RegExp(`(?:^|\\n)${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    const field = rule('.field-control');
    expect(field).toMatch(/height:\s*36px/);
    expect(field).toContain('var(--color-border-strong)');
    expect(field).toContain('var(--radius-md)');
    expect(rule('select.field-control')).toMatch(/appearance:\s*none/);
    expect(rule('.field-sm')).toMatch(/height:\s*28px/);
  });

  it('every text-like input and select in the app uses it', () => {
    const offenders = files(join(src, 'features')).flatMap((f) => {
      const rel = f.slice(src.length);
      if (EXEMPT.has(rel)) return [];
      const text = readFileSync(f, 'utf8');
      return tags(text)
        .filter(({ attrs }) => !/type="(checkbox|radio|range|color|hidden|file)"/.test(attrs))
        .filter(({ attrs }) => !EXEMPT_ATTRS.test(attrs) && !attrs.includes('field-control'))
        .map(({ at }) => `${rel}:${text.slice(0, at).split('\n').length}`);
    });
    expect(offenders).toEqual([]);
  });
});
