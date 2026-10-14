// The block gutter of the Split pane (M4 §4, §5): next to the block under the
// pointer (and the one with the keyboard) a grip, Move up / Move down, and
// for list items Indent / Outdent. One tab stop; ↑/↓ go from block to block,
// Alt+arrows move, Enter picks a block up to choose where it goes.
import type { EditorView } from '@codemirror/view';
import type { TFunction } from 'i18next';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  indentSlot,
  movableBlocks,
  neighbourSlot,
  slotAt,
  slotsFor,
  type BlockModel,
  type Slot,
  type Unit,
} from '../../markdown/blockModel';
import type { ParsedPage } from '../../markdown/types';
import { applyMove, modelFor } from './blockCommands';
import styles from './BlockGutter.module.css';

export interface Shown {
  text: string;
  page: ParsedPage;
}

const TAGS: Record<Unit['kind'], RegExp> = {
  heading: /^H[1-6]$/,
  paragraph: /^P$/,
  embed: /^(DIV|P)$/,
  list: /^(UL|OL)$/,
  listItem: /^LI$/,
  quote: /^BLOCKQUOTE$/,
  callout: /^DIV$/,
  code: /^PRE$/,
  table: /^TABLE$/,
  tableRow: /^TR$/,
  html: /^DIV$/,
  columns: /^DIV$/,
  rule: /^HR$/,
  other: /./,
};

/** Each unit's rendered element: the outermost element of its kind starting
 *  on its first line (blocks of embedded notes aside). */
function anchorsOf(pane: HTMLElement, model: BlockModel, text: string): Map<number, HTMLElement> {
  const els = [...pane.querySelectorAll<HTMLElement>('[data-source-start]')].filter(
    (el) => !el.closest('[data-note-embed]'),
  );
  const out = new Map<number, HTMLElement>();
  for (const u of model.units) {
    const first = u.from + (/^[ \t]*/.exec(text.slice(u.from, u.to))?.[0].length ?? 0);
    const el = els.find((e) => {
      const at = Number(e.dataset.sourceStart);
      return at >= u.from && at <= first && TAGS[u.kind].test(e.tagName);
    });
    if (el) out.set(u.id, el);
  }
  return out;
}

const KIND_LABEL: Partial<Record<Unit['kind'], string>> = {
  code: 'code',
  table: 'table',
  rule: 'rule',
  embed: 'embed',
  html: 'html',
  columns: 'columns',
  list: 'list',
};

/** A short name for a block: its first line's text, or its kind. */
export function summaryOf(text: string, unit: Unit, t: TFunction): string {
  const line = text.slice(unit.from, unit.to).split(/\r?\n/)[0];
  const words = line
    .replace(/^[ \t>]*/, '')
    .replace(/^(#{1,6}[ \t]+|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/, '')
    .replace(/\[!(\w+)\][+-]?/, '$1')
    .replace(/[*_`~=[\]|#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const short = words.length > 40 ? `${words.slice(0, 39)}…` : words;
  const kind = KIND_LABEL[unit.kind];
  if (unit.kind === 'list') return `${t('editor.blocks.kinds.list')}: ${short}`;
  if (kind && unit.kind !== 'embed') return t(`editor.blocks.kinds.${kind}`);
  return short || t(`editor.blocks.kinds.${kind ?? 'other'}`);
}

/** Where a slot is drawn, in the pane's content coordinates. */
function slotLine(
  pane: HTMLElement,
  model: BlockModel,
  slot: Slot,
  anchors: Map<number, HTMLElement>,
): { top: number; left: number; width: number } | null {
  const box = (id: number) => {
    const el = anchors.get(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const p = pane.getBoundingClientRect();
    return {
      top: r.top - p.top + pane.scrollTop,
      left: r.left - p.left + pane.scrollLeft,
      width: r.width,
      height: r.height,
    };
  };
  const before = (id: number) => {
    const b = box(id);
    return b && { top: b.top - 3, left: b.left, width: b.width };
  };
  const after = (id: number, indent = 0) => {
    const b = box(id);
    return b && { top: b.top + b.height + 1, left: b.left + indent, width: b.width - indent };
  };
  switch (slot.scope) {
    case 'top': {
      if (slot.before !== null) return before(slot.before);
      const tops = model.units.filter((u) => u.scope === 'top');
      return tops.length ? after(tops[tops.length - 1].id) : null;
    }
    case 'item': {
      if (slot.before !== null) return before(slot.before);
      return after(model.lists[slot.list].items.at(-1)!);
    }
    case 'child':
      return after(slot.of, 24);
    case 'row': {
      if (slot.before !== null) return before(slot.before);
      return after(model.tables[slot.table].rows.at(-1)!);
    }
  }
}

interface Picking {
  unit: number;
  slots: Slot[];
  index: number;
  lineOnly: boolean;
}

export function BlockGutter({
  view,
  pane,
  shown,
}: {
  view: EditorView;
  pane: RefObject<HTMLDivElement | null>;
  shown: Shown | null;
}) {
  const { t } = useTranslation();
  const model = useMemo(() => (shown ? movableBlocks(shown.text, shown.page) : null), [shown]);
  const [anchors, setAnchors] = useState<Map<number, HTMLElement>>(new Map());
  const [hover, setHover] = useState<number[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const [picking, setPicking] = useState<Picking | null>(null);
  const [status, setStatus] = useState('');
  const [flash, setFlash] = useState<number | null>(null);
  /** The gutter showing its buttons (hovered, or holding the keyboard). */
  const [opened, setOpened] = useState<number | null>(null);
  const [, relayout] = useState(0);
  const layer = useRef<HTMLDivElement>(null);
  const focusNext = useRef(false);
  /** After a move: the offset the moved block starts at in the new text. */
  const movedAt = useRef<number | null>(null);
  /** A pointer drag in progress (M4 §4): which block, and where it would land. */
  const [dragging, setDragging] = useState<{
    id: number;
    slot: Slot | null;
    x: number;
    y: number;
  } | null>(null);
  // What the window listeners of a drag read.
  const live = useRef<{
    model: BlockModel | null;
    anchors: Map<number, HTMLElement>;
    move: (id: number, slot: Slot | null, lineOnly?: boolean) => void;
  }>({ model, anchors, move: () => undefined });

  // The rendered elements of the version shown (the pane commits first).
  useLayoutEffect(() => {
    if (!pane.current || !model || !shown) return setAnchors(new Map());
    setAnchors(anchorsOf(pane.current, model, shown.text));
  }, [pane, model, shown]);

  const order = useMemo(
    () => (model ? model.units.filter((u) => anchors.has(u.id)).map((u) => u.id) : []),
    [model, anchors],
  );
  const tabStop = current !== null && anchors.has(current) ? current : (order[0] ?? null);
  const name = useCallback(
    (id: number) => (model && shown ? summaryOf(shown.text, model.units[id], t) : ''),
    [model, shown, t],
  );

  // A moved block keeps the keyboard and flashes once the pane shows it.
  useEffect(() => {
    if (!model || movedAt.current === null) return;
    const at = movedAt.current;
    const moved = model.units
      .filter((u) => u.from === at && anchors.has(u.id))
      .sort((a, b) => a.to - a.from - (b.to - b.from))[0];
    if (!moved) return;
    movedAt.current = null;
    setCurrent(moved.id);
    setFlash(moved.id);
    focusNext.current = true;
    const timer = setTimeout(() => setFlash(null), 600);
    return () => clearTimeout(timer);
  }, [model, anchors]);

  // A pick-up made on blocks that have since changed is off.
  const pickedOn = useRef<BlockModel | null>(null);
  useEffect(() => {
    if (picking && pickedOn.current && pickedOn.current !== model) {
      setPicking(null);
      setStatus(t('editor.blocks.cancelled'));
    }
    pickedOn.current = model;
  }, [model, picking, t]);

  // The grip with the keyboard follows `current`.
  useEffect(() => {
    if (!focusNext.current || tabStop === null) return;
    focusNext.current = false;
    layer.current?.querySelector<HTMLElement>(`[data-grip="${tabStop}"]`)?.focus();
  }, [tabStop, anchors]);

  // Hover: the blocks under the pointer, outermost first.
  useEffect(() => {
    const p = pane.current;
    if (!p) return;
    const over = (e: Event) => {
      const target = e.target as Element;
      if (layer.current?.contains(target)) return;
      // The deepest block under the pointer: a list item, not its list (a
      // list shows its own gutter from its margin, outside its items).
      const deepest = [...anchors.entries()]
        .filter(([, el]) => el.contains(target))
        .sort(([, a], [, b]) => (a.contains(b) ? 1 : b.contains(a) ? -1 : 0))[0];
      setHover(deepest ? [deepest[0]] : []);
    };
    const leave = () => setHover([]);
    const moved = () => relayout((n) => n + 1);
    p.addEventListener('mouseover', over);
    p.addEventListener('mouseleave', leave);
    p.addEventListener('scroll', moved);
    window.addEventListener('resize', moved);
    return () => {
      p.removeEventListener('mouseover', over);
      p.removeEventListener('mouseleave', leave);
      p.removeEventListener('scroll', moved);
      window.removeEventListener('resize', moved);
    };
  }, [pane, anchors]);

  /** Moves a block of the version shown; nothing when the editor has moved
   *  on (the pane catches up within its render delay). */
  const move = (id: number, slot: Slot | null, lineOnly = false) => {
    if (!slot || !shown || view.state.doc.toString() !== shown.text) return;
    const fresh = modelFor(view.state).model;
    const label = name(id);
    if (applyMove(view, fresh.units[id], slot, { lineOnly }) !== 'moved') return;
    movedAt.current = view.state.selection.main.head;
    setStatus(t('editor.blocks.moved', { block: label }));
  };

  live.current = { model, anchors, move };

  /** The slot nearest to the pointer: by height, and for list levels also by
   *  how far right the pointer is. */
  const nearest = (id: number, lineOnly: boolean, x: number, y: number): Slot | null => {
    const { model: m, anchors: a } = live.current;
    const p = pane.current;
    if (!m || !p) return null;
    const pr = p.getBoundingClientRect();
    const cx = x - pr.left + p.scrollLeft;
    const cy = y - pr.top + p.scrollTop;
    let best: { slot: Slot; d: number } | null = null;
    for (const slot of slotsFor(m, m.units[id], lineOnly)) {
      const line = slotLine(p, m, slot, a);
      if (!line) continue;
      const nested = slot.scope === 'item' || slot.scope === 'child';
      const d = Math.abs(cy - line.top) + (nested ? 0.3 * Math.abs(cx - line.left) : 0);
      if (!best || d < best.d) best = { slot, d };
    }
    return best?.slot ?? null;
  };

  /** Pressing a grip: past 4 px it's a drag; Escape cancels; the drop moves
   *  the block (Alt held: a heading without its section). */
  const startDrag = (e: ReactPointerEvent, id: number) => {
    if (e.button !== 0 || !live.current.model) return;
    const unit = live.current.model.units[id];
    const from = { x: e.clientX, y: e.clientY };
    let started = false;
    let last: { slot: Slot | null; lineOnly: boolean } = { slot: null, lineOnly: false };
    let frame = 0;
    let lastY = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const scroll = () => {
      const p = pane.current;
      frame = 0;
      if (!p || !started) return;
      const r = p.getBoundingClientRect();
      const edge = 40;
      const speed =
        lastY < r.top + edge
          ? -(r.top + edge - lastY) / 3
          : lastY > r.bottom - edge
            ? (lastY - (r.bottom - edge)) / 3
            : 0;
      if (speed) {
        p.scrollTop += speed;
        frame = requestAnimationFrame(scroll);
      }
    };
    const onMove = (ev: PointerEvent) => {
      if (!started && Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < 4) return;
      started = true;
      lastY = ev.clientY;
      const lineOnly = ev.altKey && unit.kind === 'heading';
      last = { slot: nearest(id, lineOnly, ev.clientX, ev.clientY), lineOnly };
      setDragging({ id, slot: last.slot, x: ev.clientX, y: ev.clientY });
      if (!frame) frame = requestAnimationFrame(scroll);
    };
    const stop = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onEscape);
      if (frame) cancelAnimationFrame(frame);
      setDragging(null);
    };
    const onUp = (ev: PointerEvent) => {
      stop();
      if (!started) return;
      const lineOnly = ev.altKey && unit.kind === 'heading';
      const slot =
        lineOnly === last.lineOnly ? last.slot : nearest(id, lineOnly, ev.clientX, ev.clientY);
      live.current.move(id, slot, lineOnly);
    };
    const onEscape = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      started = false;
      stop();
      // The release that follows drops nothing: its listener is gone.
      setStatus(t('editor.blocks.cancelled'));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onEscape);
  };

  const describe = (slot: Slot): string => {
    switch (slot.scope) {
      case 'top':
        return slot.before === null
          ? t('editor.blocks.slot.end')
          : t('editor.blocks.slot.before', { block: name(slot.before) });
      case 'item':
        return slot.before === null
          ? t('editor.blocks.slot.endOfList')
          : t('editor.blocks.slot.before', { block: name(slot.before) });
      case 'child':
        return t('editor.blocks.slot.inside', { block: name(slot.of) });
      case 'row':
        return slot.before === null
          ? t('editor.blocks.slot.endOfTable')
          : t('editor.blocks.slot.before', { block: name(slot.before) });
    }
  };

  const onKey = (e: ReactKeyboardEvent, id: number) => {
    if (!model || !shown) return;
    // Until the pane shows the editor's text (a move a moment ago), a key
    // would act on blocks that have moved: it waits.
    if (view.state.doc.toString() !== shown.text) {
      if (e.key.startsWith('Arrow') || e.key === 'Enter' || e.key === ' ') e.preventDefault();
      return;
    }
    const unit = model.units[id];
    if (picking) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const index = Math.max(
          0,
          Math.min(picking.slots.length - 1, picking.index + (e.key === 'ArrowDown' ? 1 : -1)),
        );
        setPicking({ ...picking, index });
        setStatus(describe(picking.slots[index]));
      } else if (e.key === 'Enter' || e.key === ' ') {
        setPicking(null);
        move(picking.unit, picking.slots[picking.index], picking.lineOnly);
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        setPicking(null);
        setStatus(t('editor.blocks.cancelled'));
        if (e.key === 'Tab') return;
      } else return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const plain = !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey;
    if (plain && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const k = order.indexOf(id) + (e.key === 'ArrowDown' ? 1 : -1);
      if (k >= 0 && k < order.length) {
        focusNext.current = true;
        setCurrent(order[k]);
      }
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      move(id, neighbourSlot(model, unit, e.key === 'ArrowUp' ? -1 : 1, e.shiftKey), e.shiftKey);
    } else if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      move(id, indentSlot(model, unit, e.key === 'ArrowRight' ? 1 : -1));
    } else if (plain && (e.key === 'Enter' || e.key === ' ')) {
      const slots = slotsFor(model, unit, false);
      if (!slots.length) return;
      const after = slots.findIndex((s) => slotAt(model, s) > unit.from);
      const index = after < 0 ? slots.length - 1 : after;
      setPicking({ unit: id, slots, index, lineOnly: false });
      setStatus(`${t('editor.blocks.picked', { block: name(id) })} ${describe(slots[index])}`);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  if (!model || !shown || !pane.current) {
    return <div ref={layer} className={styles.layer} />;
  }
  const p = pane.current;
  const pr = p.getBoundingClientRect();
  const placeOf = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return {
      top: r.top - pr.top + p.scrollTop,
      left: r.left - pr.left + p.scrollLeft,
      width: r.width,
      height: r.height,
    };
  };
  const visible = [
    ...new Set([
      ...hover,
      ...(tabStop !== null ? [tabStop] : []),
      ...(picking ? [picking.unit] : []),
    ]),
  ];
  const dropSlot = picking ? picking.slots[picking.index] : (dragging?.slot ?? null);
  const drop = dropSlot ? slotLine(p, model, dropSlot, anchors) : null;

  return (
    <div ref={layer} className={styles.layer}>
      <div className={styles.srOnly} role="status" data-block-status="">
        {status}
      </div>
      <span id="block-gutter-help" className={styles.srOnly}>
        {t('editor.blocks.help')}
      </span>
      {flash !== null && anchors.get(flash) && (
        <div className={styles.flash} style={placeOf(anchors.get(flash)!)} aria-hidden="true" />
      )}
      {drop && <div className={styles.drop} style={drop} aria-hidden="true" data-drop-line="" />}
      {dragging && (
        <div
          className={styles.ghost}
          style={{ left: dragging.x + 12, top: dragging.y + 8 }}
          aria-hidden="true"
        >
          {name(dragging.id)}
        </div>
      )}
      {visible.map((id) => {
        const el = anchors.get(id);
        if (!el) return null;
        const at = placeOf(el);
        const unit = model.units[id];
        const label = name(id);
        const shownNow = hover.includes(id) || picking?.unit === id;
        const button = (key: string, onClick: () => void, glyph: string) => (
          <button
            type="button"
            tabIndex={-1}
            className={styles.button}
            aria-label={t(`editor.blocks.${key}`)}
            title={t(`editor.blocks.${key}`)}
            // The editor keeps the keyboard when these are clicked.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClick}
          >
            <span aria-hidden="true">{glyph}</span>
          </button>
        );
        return (
          <div
            key={id}
            role="group"
            aria-label={label}
            className={
              shownNow || opened === id ? styles.gutter : `${styles.gutter} ${styles.idle}`
            }
            onMouseEnter={() => setOpened(id)}
            onMouseLeave={(e) => {
              if (!e.currentTarget.contains(document.activeElement)) setOpened(null);
            }}
            onFocus={() => setOpened(id)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpened(null);
            }}
            style={{ top: at.top, left: at.left - (unit.scope === 'item' ? 40 : 26) }}
          >
            <button
              type="button"
              data-grip={id}
              className={styles.grip}
              tabIndex={id === tabStop ? 0 : -1}
              aria-label={t('editor.blocks.grip', { block: label })}
              aria-describedby="block-gutter-help"
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Enter"
              onFocus={() => setCurrent(id)}
              onKeyDown={(e) => onKey(e, id)}
              onPointerDown={(e) => startDrag(e, id)}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <circle cx="9" cy="6" r="1.8" />
                <circle cx="15" cy="6" r="1.8" />
                <circle cx="9" cy="12" r="1.8" />
                <circle cx="15" cy="12" r="1.8" />
                <circle cx="9" cy="18" r="1.8" />
                <circle cx="15" cy="18" r="1.8" />
              </svg>
            </button>
            {/* Shown while the gutter is hovered or has the keyboard. */}
            {opened === id && (
              <div className={styles.extra}>
                {button('moveUp', () => move(id, neighbourSlot(model, unit, -1)), '↑')}
                {button('moveDown', () => move(id, neighbourSlot(model, unit, 1)), '↓')}
                {unit.scope === 'item' &&
                  button('indent', () => move(id, indentSlot(model, unit, 1)), '→')}
                {unit.scope === 'item' &&
                  button('outdent', () => move(id, indentSlot(model, unit, -1)), '←')}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
