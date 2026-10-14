// Code block languages (M4b part 2 §2): the names CodeMirror's language data
// knows, each with the short id written into the fence.
import { languages } from '@codemirror/language-data';
import type { EditorView } from '@codemirror/view';

export interface LanguageChoice {
  name: string;
  /** Written after the fence: the shortest alias, else the name. */
  id: string;
  aliases: readonly string[];
}

export const LANGUAGE_CHOICES: LanguageChoice[] = languages
  .map((d) => {
    const short = [...d.alias].sort((a, b) => a.length - b.length)[0];
    return {
      name: d.name,
      id: short ?? d.name.toLowerCase().replace(/\s+/g, '-'),
      aliases: d.alias,
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

/** Languages whose name or an alias contains `query` (names first). */
export function filterLanguages(query: string): LanguageChoice[] {
  const q = query.trim().toLowerCase();
  if (!q) return LANGUAGE_CHOICES;
  const byName = LANGUAGE_CHOICES.filter((l) => l.name.toLowerCase().includes(q));
  const byAlias = LANGUAGE_CHOICES.filter(
    (l) => !byName.includes(l) && l.aliases.some((a) => a.includes(q)),
  );
  return [...byName, ...byAlias];
}

const FENCE = /^(\s*)(`{3,}|~{3,})(\S*)(.*)$/;

/** Rewrites the language of the fence on the line holding `at` (one undoable
 *  change); `id` empty for plain text. `false` when that line isn't a fence. */
export function setFenceLanguage(view: EditorView, at: number, id: string): boolean {
  const line = view.state.doc.lineAt(at);
  const m = FENCE.exec(line.text);
  if (!m) return false;
  const from = line.from + m[1].length + m[2].length;
  view.dispatch({
    changes: { from, to: from + m[3].length, insert: id },
    userEvent: 'input.language',
  });
  return true;
}
