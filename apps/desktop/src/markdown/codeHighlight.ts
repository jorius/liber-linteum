// Syntax highlighting of fenced code (M4b part 2 §2). The rendered pane uses
// lowlight (highlight.js grammars, the common set); the editor uses
// CodeMirror's language data. Both draw with the same `--code-*` tokens, and
// both name languages through the language data, so labels match.
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import type { Element, ElementContent, Root } from 'hast';
import { common, createLowlight } from 'lowlight';

const lowlight = createLowlight(common);

/** Fences drawn as something else (maths, diagrams), never as code. */
export const NOT_CODE = new Set(['mermaid', 'math']);

/** The language's display name ("JavaScript"), or the info as written. */
export function languageName(info: string): string {
  const desc = LanguageDescription.matchLanguageName(languages, info, true);
  return desc?.name ?? info;
}

/** lowlight's name for a fence language, if it has a grammar for it. */
function grammarFor(lang: string): string | null {
  const l = lang.toLowerCase();
  if (lowlight.registered(l)) return l;
  const desc = LanguageDescription.matchLanguageName(languages, lang, true);
  for (const alias of desc ? [desc.name, ...desc.alias] : []) {
    if (lowlight.registered(alias.toLowerCase())) return alias.toLowerCase();
  }
  return null;
}

function textOf(n: ElementContent): string {
  if (n.type === 'text') return n.value;
  if (n.type === 'element') return n.children.map(textOf).join('');
  return '';
}

/** Highlights every `pre > code.language-x` in place and records the fence's
 *  language on the `pre` (`data-lang`). Runs before sanitizing, whose schema
 *  keeps only `hljs-*` classes. */
export function highlightCode(root: Root | Element) {
  for (const child of root.children) {
    if (child.type !== 'element') continue;
    if (child.tagName === 'pre') {
      const code = child.children.find(
        (c): c is Element => c.type === 'element' && c.tagName === 'code',
      );
      const cls = code ? ([] as unknown[]).concat(code.properties.className ?? []) : [];
      const lang = cls
        .map(String)
        .find((c) => c.startsWith('language-'))
        ?.slice(9);
      if (code && lang?.toLowerCase() === 'mermaid') child.properties.dataLang = 'mermaid';
      if (code && lang && !NOT_CODE.has(lang.toLowerCase())) {
        child.properties.dataLang = lang;
        const grammar = grammarFor(lang);
        if (grammar) {
          const tree = lowlight.highlight(grammar, code.children.map(textOf).join(''));
          code.children = tree.children as ElementContent[];
        }
      }
      continue;
    }
    highlightCode(child);
  }
}
