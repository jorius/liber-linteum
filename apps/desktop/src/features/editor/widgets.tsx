import { WidgetType, type EditorView } from '@codemirror/view';
import { createRoot, type Root } from 'react-dom/client';
import { Preview } from '../preview/Preview';

/** A block (table, callout, columns, embed, rule) rendered with the preview
 *  components (M2a §3.2). A click outside its links moves the cursor into
 *  the block, which shows its source. */
export class PreviewWidget extends WidgetType {
  private root: Root | null = null;

  constructor(
    readonly text: string,
    readonly path: string,
  ) {
    super();
  }

  eq(other: PreviewWidget): boolean {
    return other.text === this.text && other.path === this.path;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'cm-nimw-widget';
    dom.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('a, button, input, audio, video, summary')) return;
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(dom) } });
      view.focus();
    });
    this.root = createRoot(dom);
    this.root.render(<Preview text={this.text} path={this.path} embedded />);
    return dom;
  }

  destroy(): void {
    const root = this.root;
    this.root = null;
    // Not while React may be rendering (CodeMirror updates run inside effects).
    if (root) queueMicrotask(() => root.unmount());
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** `[ ]` / `[x]` of a task item: a checkbox that edits the source. */
export class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly label: string,
  ) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.label === this.label;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.tabIndex = -1;
    box.className = 'cm-nimw-checkbox';
    box.setAttribute('aria-label', this.label);
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const at = view.posAtDOM(box) + 1; // the character inside the brackets
      view.dispatch({
        changes: { from: at, to: at + 1, insert: this.checked ? ' ' : 'x' },
        userEvent: 'input.toggle',
      });
    });
    return box;
  }

  ignoreEvent(): boolean {
    return true;
  }
}
