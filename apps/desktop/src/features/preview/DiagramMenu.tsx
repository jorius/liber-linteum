import { EditorView } from '@codemirror/view';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openDiagramPreview } from './openDiagramPreview';
import { PopupMenu } from './PopupMenu';

/** The rendered diagram or block maths under `target`, in the editor or the
 *  rendered pane; inline maths (a `span`) is not one. */
export function diagramAt(target: EventTarget | null): HTMLElement | null {
  const el = (target as Element | null)?.closest?.<HTMLElement>(
    '[data-liber="diagram"], div[data-liber="math"]',
  );
  return el?.closest('.cm-editor, [data-preview]') ? el : null;
}

/** Edit source: the cursor goes to the diagram's source, which then shows. */
function editSource(el: HTMLElement) {
  const view = EditorView.findFromDOM(el.closest<HTMLElement>('.cm-editor')!);
  if (!view) return;
  view.dispatch({ selection: { anchor: view.posAtDOM(el) } });
  view.focus();
}

/** Opens Preview / Edit source on a right-click on a diagram or block maths
 *  (Part B). A left click still edits it. Listens first (capture), like the
 *  image menu. */
export function DiagramMenuHost() {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{
    el: HTMLElement;
    anchor: { x: number; y: number };
    before: Element | null;
  } | null>(null);
  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      const el = diagramAt(e.target);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      setMenu({ el, anchor: { x: e.clientX, y: e.clientY }, before: document.activeElement });
    };
    // A right press would move the editor's cursor into the block, which then
    // shows its source in place of the drawing before the menu event arrives.
    const onDown = (e: MouseEvent) => {
      if (e.button === 2 && diagramAt(e.target)?.closest('.cm-editor')) e.stopPropagation();
    };
    document.addEventListener('contextmenu', onMenu, true);
    document.addEventListener('mousedown', onDown, true);
    return () => {
      document.removeEventListener('contextmenu', onMenu, true);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, []);
  const close = useRef(() => setMenu(null)).current;
  if (!menu) return null;
  const { el, before } = menu;
  const items = [
    {
      label: t('diagram.preview'),
      run: () => {
        // Focus back off the menu first, so the dialog returns it there.
        if (before instanceof HTMLElement) before.focus();
        openDiagramPreview(el);
      },
    },
    // The rendered pane has no source position to go to.
    ...(el.closest('.cm-editor')
      ? [{ label: t('diagram.editSource'), run: () => editSource(el) }]
      : []),
  ];
  return <PopupMenu label={t('diagram.menu')} items={items} anchor={menu.anchor} onClose={close} />;
}
