import type { EditorView } from '@codemirror/view';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { aliasFor } from './linkComplete';
import { pagePath } from './livePreview';
import { PickerPopup, type PickerOption } from './PickerPopup';

/** Text that can sit in `[[target|…]]`: brackets, pipes and line breaks would
 *  end or split the link, so they become spaces (final review M11). */
const linkSafe = (text: string) => text.replace(/[[\]|\r\n]/g, ' ').replace(/\s{2,}/g, ' ');

/** "Link to…" (M2c §6.3): a combobox over the vault's pages, plus the typed
 *  web address. A page links the selection as `[[target|selection]]` (or
 *  `[[target]]` / `[[target|Title]]` without one); a URL gives `[text](url)`.
 *  It follows the selection while the editor scrolls (M4b §4). */
export function LinkPicker({ view, onClose }: { view: EditorView; onClose: () => void }) {
  const { t } = useTranslation();
  const anchor = useCallback(() => {
    const at = view.coordsAtPos(view.state.selection.main.from);
    return at ? { top: at.top, bottom: at.bottom, left: at.left } : null;
  }, [view]);

  const close = (refocus: boolean) => {
    onClose();
    if (refocus) view.focus();
  };
  const pick = (o: PickerOption) => {
    // The live selection: CodeMirror maps it through changes made while the
    // picker is open, such as a merge from disk (final review M11).
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    let insert: string;
    if (o.kind === 'url') insert = `[${selected.replace(/\n/g, ' ') || o.url}](${o.url})`;
    else {
      const own = linkSafe(selected);
      const alias = own.trim() ? own : aliasFor(o.page);
      insert = alias ? `[[${o.page.target}|${alias}]]` : `[[${o.page.target}]]`;
    }
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      scrollIntoView: true,
      userEvent: 'input.link',
    });
    close(true);
  };
  return (
    <PickerPopup
      source={view.state.facet(pagePath)()}
      anchor={anchor}
      allowUrl
      label={t('linkPicker.label')}
      placeholder={t('linkPicker.placeholder')}
      onPick={pick}
      onClose={close}
    />
  );
}
