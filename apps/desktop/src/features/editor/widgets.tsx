import { WidgetType, type EditorView } from '@codemirror/view';
import i18next from 'i18next';
import type { WideElements } from '../../ipc';
import { languageName } from '../../markdown/codeHighlight';
import { renderMath } from '../preview/MathView';
import { announce } from './announce';
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
 *  the block, which shows its source. `kind` names the wide-elements choice
 *  (M4b part 3) that lets it escape the readable measure, if any. */
export class PreviewWidget extends WidgetType {
  private root: Root | null = null;

  constructor(
    readonly text: string,
    readonly path: string,
    readonly kind: keyof WideElements | null = null,
  ) {
    super();
  }

  eq(other: PreviewWidget): boolean {
    return other.text === this.text && other.path === this.path && other.kind === this.kind;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'cm-nimw-widget';
    if (this.kind) dom.dataset.wideKind = this.kind;
    dom.addEventListener('mousedown', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('a, button, input, audio, video, summary')) return;
      // A press on a table's scroll box itself, not a cell, is on its
      // scrollbar: the box scrolls and the table stays (final review I3).
      if (target.matches('[data-table-scroll]')) return;
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(dom) } });
      view.focus();
    });
    this.root = createRoot(dom);
    // The widget's text starts where the widget does, so a task offset inside
    // it maps to the page by adding the widget's position.
    const toggle = (at: number) => toggleTaskIn(view, view.posAtDOM(dom) + at);
    // A read-only page (archived) shows its tasks, unticked by clicks (round-2 review M4).
    this.root.render(
      <Preview
        text={this.text}
        path={this.path}
        embedded
        onToggleTask={view.state.readOnly ? undefined : toggle}
      />,
    );
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
    box.disabled = view.state.readOnly; // archived (round-2 review M4)
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (view.state.readOnly) return;
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

/** Copies `text` and says so on `button` for a moment (M4b part 2 §2), and
 *  to screen readers; a copy that fails says that (final review M7). */
export function copyWithFeedback(text: string, label: HTMLElement): void {
  const say = (key: 'code.copied' | 'code.copyFailed') => {
    label.textContent = i18next.t(key);
    announce(i18next.t(key), true);
    setTimeout(() => (label.textContent = i18next.t('code.copy')), 1500);
  };
  const clipboard = navigator.clipboard;
  if (!clipboard) return say('code.copyFailed');
  void clipboard.writeText(text).then(
    () => say('code.copied'),
    () => say('code.copyFailed'),
  );
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

/** A bullet list's marker in Live Preview (round 3 §1); the source `-`, `*`
 *  or `+` shows on the cursor line. */
export class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const dot = document.createElement('span');
    dot.className = 'cm-nimw-bullet';
    dot.textContent = '•';
    return dot;
  }
}

/** Inline maths in Live Preview (M4b part 2 §3); a click puts the cursor in
 *  it, which shows its source. */
export class InlineMathWidget extends WidgetType {
  constructor(readonly tex: string) {
    super();
  }

  eq(other: InlineMathWidget): boolean {
    return other.tex === this.tex;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-nimw-math';
    renderMath(this.tex, el, false);
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(el) + 1 } });
      view.focus();
    });
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}
