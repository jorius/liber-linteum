import { useUiStore } from '../../stores/uiStore';

/** Opens the zoom / pan dialog on a rendered diagram or block maths, showing
 *  a copy of its markup (already sanitised; never drawn again). */
export function openDiagramPreview(el: HTMLElement): void {
  useUiStore.getState().openDialog({
    type: 'diagramPreview',
    html: el.innerHTML,
    kind: el.matches('[data-liber="diagram"]') ? 'diagram' : 'math',
    returnTo: document.activeElement instanceof HTMLElement ? document.activeElement : null,
  });
}
