// Syntax highlighting of fenced code (M4b part 2 §2). The rendered pane uses
// lowlight (highlight.js grammars, the common set); the editor uses
// CodeMirror's language data. Both draw with the same `--code-*` tokens, and
// both name languages through the language data, so labels match.
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import type { Element, ElementContent, Root } from 'hast';
import { common, createLowlight } from 'lowlight';

// One grammar at a time, by name: lowlight's map form (`createLowlight(common)`)
// calls `Object.hasOwn`, which WKWebView only has from Safari 15.4, and it ran
// as the bundle loaded — a blank window on macOS 12.0–12.2 (final review C1).
const lowlight = createLowlight();
for (const [name, grammar] of Object.entries(common)) lowlight.register(name, grammar);

/** Fences drawn as something else (maths, diagrams), never as code. */
export const NOT_CODE = new Set(['mermaid', 'math']);

/** The id the language picker writes after a fence (M4b part 2 §10.5): the
 *  shortest alias without white space — on a tie, a plain word (`cpp`, not
 *  `c++`), then the name in lower case (`xml`, not `rss`) — else the name in
 *  lower case without its spaces (`mssql`; final review I1). */
export function fenceId(desc: LanguageDescription): string {
  const name = desc.name.toLowerCase();
  const plain = (a: string) => (/^[a-z0-9_-]+$/.test(a) ? 0 : 1);
  const [best] = desc.alias
    .filter((a) => a && !/\s/.test(a))
    .sort(
      (a, b) =>
        a.length - b.length || plain(a) - plain(b) || Number(a !== name) - Number(b !== name),
    );
  return best ?? name.replace(/\s+/g, '');
}

const byId = new Map<string, LanguageDescription>();
for (const desc of languages) if (!byId.has(fenceId(desc))) byId.set(fenceId(desc), desc);

/** The language a fence names: an id the picker writes, else language-data's
 *  own match (name or alias, then a known name inside the info). */
export function languageFor(info: string): LanguageDescription | null {
  return (
    byId.get(info.toLowerCase()) ?? LanguageDescription.matchLanguageName(languages, info, true)
  );
}

/** The language's display name ("JavaScript"), or the info as written. */
export function languageName(info: string): string {
  return languageFor(info)?.name ?? info;
}

/** lowlight's name for a fence language, if it has a grammar for it — or for
 *  a language it names (`mssql` is highlighted as SQL). */
function grammarFor(lang: string): string | null {
  const l = lang.toLowerCase();
  if (lowlight.registered(l)) return l;
  const descs = [languageFor(lang), LanguageDescription.matchLanguageName(languages, lang, true)];
  for (const desc of descs) {
    for (const alias of desc ? [desc.name, ...desc.alias] : []) {
      if (lowlight.registered(alias.toLowerCase())) return alias.toLowerCase();
    }
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
          try {
            const tree = lowlight.highlight(grammar, code.children.map(textOf).join(''));
            code.children = tree.children as ElementContent[];
          } catch {
            // A grammar this WebKit can't run (its patterns compile on first
            // use) leaves the code plain, never a broken page.
          }
        }
      }
      continue;
    }
    highlightCode(child);
  }
}
