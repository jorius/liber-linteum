// Code block languages (M4b part 2 §2): the names CodeMirror's language data
// knows, each with the short id written into the fence.
import { languages } from '@codemirror/language-data';
import type { EditorView } from '@codemirror/view';
import { fenceId } from '../../markdown/codeHighlight';

export interface LanguageChoice {
  name: string;
  /** Written after the fence (`fenceId`): never with white space. */
  id: string;
  aliases: readonly string[];
}

export const LANGUAGE_CHOICES: LanguageChoice[] = languages
  .map((d) => ({ name: d.name, id: fenceId(d), aliases: d.alias }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** How well a language matches `q` (lower case): 0 an exact id or alias,
 *  1 the exact name, 2 a name or alias starting with it, 3 holding it;
 *  null not at all. */
function rank(l: LanguageChoice, q: string): number | null {
  const name = l.name.toLowerCase();
  const words = [l.id, ...l.aliases];
  if (words.includes(q)) return 0;
  if (name === q) return 1;
  if (name.startsWith(q) || words.some((w) => w.startsWith(q))) return 2;
  if (name.includes(q) || words.some((w) => w.includes(q))) return 3;
  return null;
}

/** Languages whose name or an alias holds `query`, best matches first (Enter
 *  takes the first: `js` is JavaScript, `c` is C; final review I1), then by
 *  name. */
export function filterLanguages(query: string): LanguageChoice[] {
  const q = query.trim().toLowerCase();
  if (!q) return LANGUAGE_CHOICES;
  return LANGUAGE_CHOICES.flatMap((l) => {
    const r = rank(l, q);
    return r === null ? [] : [{ l, r }];
  })
    .sort((a, b) => a.r - b.r)
    .map(({ l }) => l);
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
