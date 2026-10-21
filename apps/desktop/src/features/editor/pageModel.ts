// The parsed model of the text the editor shows, for the outline and the word
// count (M4b part 2 §5): Live Preview's own when it has the text (final review
// M3: no second parse when a page opens), else re-parsed incrementally from
// the last text asked for.
import type { EditorState } from '@codemirror/state';
import { reparse } from '../../markdown/incremental';
import { parsePage } from '../../markdown/parse';
import type { ParsedPage } from '../../markdown/types';
import { onLeaveVault } from '../../stores/leaveVault';
import { livePreviewPage } from './livePreview';

/** This module's own model (never Live Preview's: `reparse` takes over the
 *  page it starts from). */
let last: { text: string; page: ParsedPage } | null = null;
onLeaveVault(() => (last = null));

export function parsedFor(text: string, state?: EditorState): ParsedPage {
  const shared = state && livePreviewPage(state, text);
  if (shared) return shared;
  if (last?.text === text) return last.page;
  const page = last ? reparse(last.page, last.text, text) : parsePage(text);
  last = { text, page };
  return page;
}
