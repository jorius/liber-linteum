import { WidgetType, type EditorView } from '@codemirror/view';
import i18next from 'i18next';
import { languageName } from '../../markdown/codeHighlight';
import { openLanguagePicker } from './languagePickerOpen';
import { createRoot, type Root } from 'react-dom/client';
import { toggleTask } from '../../markdown/tasks';
import { Preview } from '../preview/Preview';

/** Toggles the task whose list item starts at `at` in the editor's text (a
 *  rendered checkbox was clicked); a stale offset does nothing. */
export function toggleTaskIn(view: EditorView, at: number): void {
  const change = toggleTask(view.state.doc.toString(), at);
  if (change) view.dispatch({ changes: change, userEvent: 'input.toggle' });
}

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
    // The widget's text starts where the widget does, so a task offset inside
    // it maps to the page by adding the widget's position.
    const toggle = (at: number) => toggleTaskIn(view, view.posAtDOM(dom) + at);
    this.root.render(<Preview text={this.text} path={this.path} embedded onToggleTask={toggle} />);
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

/** Copies `text` and says so on `button` for a moment (M4b part 2 §2). */
export function copyWithFeedback(text: string, label: HTMLElement): void {
  const done = () => {
    label.textContent = i18next.t('code.copied');
    setTimeout(() => (label.textContent = i18next.t('code.copy')), 1500);
  };
  void navigator.clipboard?.writeText(text).then(done, () => undefined);
}

/** A fenced code block's language badge and Copy button (M4b part 2 §2),
 *  at the end of its opening fence. The badge opens the language picker. */
export class CodeBadgeWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly code: string,
  ) {
    super();
  }

  eq(other: CodeBadgeWidget): boolean {
    return other.lang === this.lang && other.code === this.code;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('span');
    box.className = 'cm-nimw-codebadge';
    const name = this.lang ? languageName(this.lang) : i18next.t('code.plain');
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'cm-nimw-codebadge-lang';
    badge.textContent = name;
    badge.setAttribute('aria-label', i18next.t('code.languageLabel', { name }));
    badge.addEventListener('mousedown', (e) => e.preventDefault());
    badge.addEventListener('click', () => openLanguagePicker(view, view.posAtDOM(box), badge));
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'cm-nimw-codebadge-copy';
    copy.textContent = i18next.t('code.copy');
    copy.setAttribute('aria-label', i18next.t('code.copyCode'));
    copy.addEventListener('mousedown', (e) => e.preventDefault());
    copy.addEventListener('click', () => copyWithFeedback(this.code, copy));
    box.append(badge, copy);
    return box;
  }

  ignoreEvent(): boolean {
    return true;
  }
}
