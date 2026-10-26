// Resizing an image in Live Preview with the mouse (0.1.2): hovering an image
// shows a handle on its bottom-right corner; dragging it sizes the image
// (proportions kept) and, on release, writes the width into its link the way
// Obsidian does: `![[x.png|420]]`, `![alt|420](x.png)`.
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { parseSize } from '../../markdown/wikilink';

const MIN_WIDTH = 32;
const WIKI = /^!\[\[([^\]]+)\]\]/;
const MARKDOWN = /^!\[([^\]]*)\]\(/;
const SIZED_ALT = /\|\s*\d+(?:\s*x\s*\d+)?\s*$/;

/** The image link at the start of `source` with its width set to `width`:
 *  `{ from: 0, to, insert }`, or `null` when `source` doesn't start with one,
 *  or a wiki embed's `|…` is text rather than a size (it stays as written). */
export function withWidth(source: string, width: number): { to: number; insert: string } | null {
  const wiki = WIKI.exec(source);
  if (wiki) {
    const inner = wiki[1];
    const bar = inner.indexOf('|');
    const alias = bar < 0 ? null : inner.slice(bar + 1);
    if (alias !== null && parseSize(alias).width === null) return null;
    const target = bar < 0 ? inner : inner.slice(0, bar);
    return { to: wiki[0].length, insert: `![[${target}|${width}]]` };
  }
  const md = MARKDOWN.exec(source);
  if (md) {
    const alt = md[1].replace(SIZED_ALT, '');
    return { to: md[0].length, insert: `![${alt}|${width}](` };
  }
  return null;
}

/** An image the handle may size: in a Live Preview widget that starts with
 *  its link (not one inside a transcluded note, a table or a callout). */
function sourceAt(view: EditorView, img: HTMLImageElement) {
  const widget = img.closest<HTMLElement>('.cm-liber-widget');
  if (!widget || img.closest('[data-note-embed]') || view.state.readOnly) return null;
  let pos: number;
  try {
    pos = view.posAtDOM(widget);
  } catch {
    return null;
  }
  const line = view.state.doc.lineAt(pos);
  const text = view.state.sliceDoc(pos, line.to);
  const lead = /^\s*/.exec(text)![0].length;
  const found = withWidth(text.slice(lead), 1);
  return found && { from: pos + lead, text: text.slice(lead) };
}

export const imageResize = ViewPlugin.fromClass(
  class {
    handle: HTMLElement;
    img: HTMLImageElement | null = null;
    dragging = false;

    constructor(readonly view: EditorView) {
      this.handle = document.createElement('div');
      this.handle.className = 'cm-liber-resize';
      this.handle.setAttribute('aria-hidden', 'true');
      this.handle.hidden = true;
      view.scrollDOM.appendChild(this.handle);
      this.handle.addEventListener('pointerdown', this.start);
      view.scrollDOM.addEventListener('pointermove', this.hover);
      view.scrollDOM.addEventListener('pointerleave', this.leave);
    }

    update(u: ViewUpdate) {
      // The widgets drew new images: the old one may be gone.
      if (!this.dragging && (u.docChanged || u.viewportChanged) && !this.img?.isConnected) {
        this.hide();
      } else if (this.img && !this.dragging) {
        this.place(this.img);
      }
    }

    destroy() {
      this.handle.remove();
      this.view.scrollDOM.removeEventListener('pointermove', this.hover);
      this.view.scrollDOM.removeEventListener('pointerleave', this.leave);
    }

    hide() {
      this.img?.classList.remove('cm-liber-sizable');
      this.img = null;
      this.handle.hidden = true;
    }

    place(img: HTMLImageElement) {
      const box = img.getBoundingClientRect();
      const scroller = this.view.scrollDOM;
      const outer = scroller.getBoundingClientRect();
      const size = this.handle.offsetWidth || 14;
      this.handle.style.left = `${box.right - outer.left + scroller.scrollLeft - size}px`;
      this.handle.style.top = `${box.bottom - outer.top + scroller.scrollTop - size}px`;
    }

    hover = (e: PointerEvent) => {
      if (this.dragging || e.target === this.handle) return;
      const img = (e.target as Element).closest?.('img');
      if (img && img !== this.img && img.complete && sourceAt(this.view, img)) {
        this.hide();
        this.img = img;
        img.classList.add('cm-liber-sizable');
        this.handle.hidden = false;
        this.place(img);
      } else if (!img) {
        this.hide();
      }
    };

    leave = () => {
      if (!this.dragging) this.hide();
    };

    start = (e: PointerEvent) => {
      const img = this.img;
      if (!img || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.dragging = true;
      this.handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startWidth = img.getBoundingClientRect().width;
      const widget = img.closest<HTMLElement>('.cm-liber-widget');
      const max = Math.max(MIN_WIDTH, widget?.clientWidth ?? startWidth);
      let width = Math.round(startWidth);
      const move = (m: PointerEvent) => {
        width = Math.round(Math.min(max, Math.max(MIN_WIDTH, startWidth + m.clientX - startX)));
        img.style.width = `${width}px`;
        img.style.height = 'auto';
        this.place(img);
      };
      const end = () => {
        this.handle.removeEventListener('pointermove', move);
        this.handle.removeEventListener('pointerup', end);
        this.handle.removeEventListener('pointercancel', end);
        this.dragging = false;
        if (width !== Math.round(startWidth)) this.commit(img, width);
      };
      this.handle.addEventListener('pointermove', move);
      this.handle.addEventListener('pointerup', end);
      this.handle.addEventListener('pointercancel', end);
    };

    commit(img: HTMLImageElement, width: number) {
      const at = sourceAt(this.view, img);
      const change = at && withWidth(at.text, width);
      if (!at || !change) return;
      this.view.dispatch({
        changes: { from: at.from, to: at.from + change.to, insert: change.insert },
        userEvent: 'input.resize',
      });
    }
  },
);
