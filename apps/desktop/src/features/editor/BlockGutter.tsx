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
import { useToastStore } from '../../stores/toastStore';
import { applyMove, modelFor } from './blockCommands';
import { pageDocOf } from './views';
import { matcher, type Seen } from './blockMatch';
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
  html: /./,
  columns: /^DIV$/,
  rule: /^HR$/,
  other: /./,
};

/** Each unit's rendered element: the outermost element of its kind starting
 *  on its first line (blocks of embedded notes aside). Linear in the blocks
 *  and elements (final review I2: it runs after every typing pause). */
export function anchorsOf(
  pane: HTMLElement,
  model: BlockModel,
  text: string,
): Map<number, HTMLElement> {
  // The elements starting at each offset, in document order.
  const at = new Map<number, HTMLElement[]>();
  for (const el of pane.querySelectorAll<HTMLElement>('[data-source-start]')) {
    if (el.closest('[data-note-embed]')) continue;
    const start = Number(el.getAttribute('data-source-start'));
    const list = at.get(start);
    if (list) list.push(el);
    else at.set(start, [el]);
  }
  const out = new Map<number, HTMLElement>();
  for (const u of model.units) {
    let first = u.from;
    while (first < u.to && (text[first] === ' ' || text[first] === '\t')) first++;
    // The first in document order of those starting from the line's start to
    // its first character.
    let best: HTMLElement | null = null;
    for (let k = u.from; k <= first; k++) {
      const el = at.get(k)?.find((e) => TAGS[u.kind].test(e.tagName));
      if (el && (!best || best.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)) {
        best = el;
      }
    }
    if (best) out.set(u.id, best);
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
    // [[target|alias]] and ![[embed]] read as their alias or target; [text](url) as its text.
    .replace(/!?\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
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
      const items = model.lists[slot.list].items;
      return after(items[items.length - 1]);
    }
    case 'child':
      return after(slot.of, 24);
    case 'row': {
      if (slot.before !== null) return before(slot.before);
      const rows = model.tables[slot.table].rows;
      return after(rows[rows.length - 1]);
    }
  }
}

/** Moves block `id` of version `origin` to `slot` of version `at`. */
type Move = (origin: Seen, id: number, slot: Slot | null, lineOnly?: boolean, at?: Seen) => void;

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
  /** The version the pane shows: what the gutter's ids and slots refer to. */
  const seen = useMemo<Seen | null>(
    () => (shown && model ? { text: shown.text, model } : null),
    [shown, model],
  );
  // Each unit's element. Until the layout effect maps a new model, the last
  // model's map stays (the gutter with the keyboard stays put): an id may be
  // missing from the new model.
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
  /** Ends the drag in progress, if any (the gutter unmounting ends it). */
  const endDrag = useRef<((unmounted?: boolean) => void) | null>(null);
  useEffect(() => () => endDrag.current?.(true), []);
  /** After a move: the offset the moved block starts at in the new text. */
  const movedAt = useRef<number | null>(null);
  /** A pointer drag in progress (M4 §4): which block, and where it would
   *  land (a slot of the version `seen`). */
  const [dragging, setDragging] = useState<{
    label: string;
    slot: Slot | null;
    seen: Seen | null;
    x: number;
    y: number;
  } | null>(null);
  // What the window listeners of a drag read.
  const live = useRef<{
    seen: Seen | null;
    anchors: Map<number, HTMLElement>;
    move: Move;
  }>({ seen, anchors, move: () => undefined });

  // The rendered elements of the version shown (the pane commits first).
  useLayoutEffect(() => {
    if (!pane.current || !model || !shown) return setAnchors(new Map());
    setAnchors(anchorsOf(pane.current, model, shown.text));
  }, [pane, model, shown]);

  const order = useMemo(
    () => (model ? model.units.filter((u) => anchors.has(u.id)).map((u) => u.id) : []),
    [model, anchors],
  );
  const tabStop =
    current !== null && anchors.has(current) && model?.units[current]
      ? current
      : (order[0] ?? null);
  const name = useCallback(
    (id: number) => (model?.units[id] && shown ? summaryOf(shown.text, model.units[id], t) : ''),
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
    const blockOf = new Map<Element, number>();
    for (const [id, el] of anchors) if (!blockOf.has(el)) blockOf.set(el, id);
    const over = (e: Event) => {
      const target = e.target as Element;
      if (layer.current?.contains(target)) return;
      // The deepest block under the pointer: a list item, not its list (a
      // list shows its own gutter from its margin, outside its items).
      let deepest: number | undefined;
      for (let n: Element | null = target; n && n !== p && deepest === undefined;) {
        deepest = blockOf.get(n);
        n = n.parentElement;
      }
      setHover(deepest !== undefined ? [deepest] : []);
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

  /** Moves block `id` of the version `origin` to `slot` (of the version
   *  `at`) in the editor's text as it is now. The text may have changed since
   *  (typing, a reload, a merge) and the editor's blocks come from another
   *  parse, so both are found again there first; when either is gone the
   *  move is cancelled (final review C2). */
  const move: Move = (origin, id, slot, lineOnly = false, at = origin) => {
    if (!slot) return;
    const now = modelFor(view.state);
    const found = matcher(origin, now);
    const unit = found.unit(id);
    const target = unit && (at === origin ? found : matcher(at, now)).slot(slot);
    const outcome = unit && target ? applyMove(view, unit, target, { lineOnly }) : 'none';
    if (outcome === 'refused') return;
    if (outcome === 'none') {
      setStatus(t('editor.blocks.cancelled'));
      useToastStore.getState().push({ message: t('editor.blocks.changed'), tone: 'error' });
      return;
    }
    movedAt.current = view.state.selection.main.head;
    setStatus(
      t('editor.blocks.moved', { block: summaryOf(origin.text, origin.model.units[id], t) }),
    );
  };

  live.current = { seen, anchors, move };

  /** The slot nearest to the pointer: by height, and for list levels also by
   *  how far right the pointer is. */
  const nearest = (id: number, lineOnly: boolean, x: number, y: number): Slot | null => {
    const { seen: v, anchors: a } = live.current;
    const m = v?.model;
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
    const origin = live.current.seen;
    if (e.button !== 0 || !origin) return;
    endDrag.current?.();
    // The page being edited: another page shown mid-drag ends it.
    const page = view.state.facet(pageDocOf);
    const handle = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    const unit = origin.model.units[id];
    const label = summaryOf(origin.text, unit, t);
    const from = { x: e.clientX, y: e.clientY };
    let started = false;
    let last: { slot: Slot | null; lineOnly: boolean; seen: Seen } = {
      slot: null,
      lineOnly: false,
      seen: origin,
    };
    // The dragged block in the version the pane shows now: the pane may
    // re-render during the drag (final review C2).
    let found: { seen: Seen | null; id: number | null } = { seen: origin, id };
    const locate = () => {
      const now = live.current.seen;
      if (now !== found.seen) {
        found = { seen: now, id: now ? (matcher(origin, now).unit(id)?.id ?? null) : null };
      }
      return found;
    };
    const slotAtPointer = (lineOnly: boolean, x: number, y: number) => {
      const here = locate();
      return {
        slot: here.id === null ? null : nearest(here.id, lineOnly, x, y),
        lineOnly,
        seen: here.seen ?? origin,
      };
    };
    let frame = 0;
    let lastY = e.clientY;
    handle.setPointerCapture?.(pointerId);
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
      if (ev.pointerId !== pointerId) return;
      // No button down: the release never arrived (an OS gesture, the
      // window losing focus).
      if (!(ev.buttons & 1) || view.state.facet(pageDocOf) !== page) return cancel();
      if (!started && Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < 4) return;
      started = true;
      lastY = ev.clientY;
      last = slotAtPointer(ev.altKey && unit.kind === 'heading', ev.clientX, ev.clientY);
      setDragging({ label, slot: last.slot, seen: last.seen, x: ev.clientX, y: ev.clientY });
      if (!frame) frame = requestAnimationFrame(scroll);
    };
    /** Ends the drag; `unmounted`: the gutter is gone, nothing to update. */
    const stop = (unmounted = false) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('pointerdown', onPress, true);
      window.removeEventListener('keydown', onEscape, true);
      window.removeEventListener('blur', cancel);
      handle.removeEventListener('lostpointercapture', cancel);
      if (frame) cancelAnimationFrame(frame);
      if (endDrag.current === stop) endDrag.current = null;
      if (!unmounted) setDragging(null);
    };
    /** Ends the drag without a drop; the release that follows drops nothing
     *  (its listener is gone). */
    const cancel = () => {
      const was = started;
      started = false;
      stop();
      if (was) setStatus(t('editor.blocks.cancelled'));
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      stop();
      if (!started) return;
      if (view.state.facet(pageDocOf) !== page) return setStatus(t('editor.blocks.cancelled'));
      const lineOnly = ev.altKey && unit.kind === 'heading';
      const drop =
        lineOnly === last.lineOnly ? last : slotAtPointer(lineOnly, ev.clientX, ev.clientY);
      live.current.move(origin, id, drop.slot, lineOnly, drop.seen);
    };
    /** A new press while this one is held: its release was lost. */
    const onPress = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId || ev.isPrimary) cancel();
    };
    const onEscape = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      // Taken before it reaches anything else (the editor, the app's keys).
      ev.preventDefault();
      ev.stopPropagation();
      started = true;
      cancel();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('pointerdown', onPress, true);
    window.addEventListener('keydown', onEscape, true);
    window.addEventListener('blur', cancel);
    handle.addEventListener('lostpointercapture', cancel);
    endDrag.current = stop;
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
    if (!model || !shown || !seen) return;
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
        move(seen, picking.unit, picking.slots[picking.index], picking.lineOnly);
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
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      move(seen, id, neighbourSlot(model, unit, dir, e.shiftKey), e.shiftKey);
    } else if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      move(seen, id, indentSlot(model, unit, e.key === 'ArrowRight' ? 1 : -1));
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

  if (!model || !shown || !seen || !pane.current) {
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
  const dropSlot = picking
    ? picking.slots[picking.index]
    : dragging?.seen === seen
      ? dragging.slot
      : null;
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
          {dragging.label}
        </div>
      )}
      {visible.map((id) => {
        const el = anchors.get(id);
        const unit = model.units[id];
        if (!el || !unit) return null;
        const at = placeOf(el);
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
                {button('moveUp', () => move(seen, id, neighbourSlot(model, unit, -1)), '↑')}
                {button('moveDown', () => move(seen, id, neighbourSlot(model, unit, 1)), '↓')}
                {unit.scope === 'item' &&
                  button('indent', () => move(seen, id, indentSlot(model, unit, 1)), '→')}
                {unit.scope === 'item' &&
                  button('outdent', () => move(seen, id, indentSlot(model, unit, -1)), '←')}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
