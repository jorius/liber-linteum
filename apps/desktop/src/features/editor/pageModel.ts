// The parsed model of the text the editor shows, for the outline and the word
// count (M4b part 2 §5): re-parsed incrementally from the last text asked for.
import { reparse } from '../../markdown/incremental';
import { parsePage } from '../../markdown/parse';
import type { ParsedPage } from '../../markdown/types';

let last: { text: string; page: ParsedPage } | null = null;

export function parsedFor(text: string): ParsedPage {
  if (last?.text === text) return last.page;
  const page = last ? reparse(last.page, last.text, text) : parsePage(text);
  last = { text, page };
  return page;
}
