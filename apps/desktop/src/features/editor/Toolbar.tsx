import type { StateCommand } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './Editor.module.css';
import { openLinkPicker } from './linkPickerOpen';
import {
  insertDivider,
  insertLink,
  setHeading,
  toggleBlock,
  toggleInline,
  type ActiveFormat,
} from './format';

interface Item {
  id: string;
  run: StateCommand;
  /** Tried first with the view (e.g. opening the Link picker). */
  open?: (view: EditorView) => boolean;
  /** Pressed when the cursor is inside this format. */
  pressed?: ActiveFormat;
  icon: ReactNode;
}

const svg = (d: string) => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const INLINE: Item[] = [
  { id: 'bold', run: toggleInline('bold'), pressed: 'bold', icon: <b>B</b> },
  { id: 'italic', run: toggleInline('italic'), pressed: 'italic', icon: <i>I</i> },
  { id: 'strike', run: toggleInline('strike'), pressed: 'strike', icon: <s>S</s> },
  {
    id: 'highlight',
    run: toggleInline('highlight'),
    pressed: 'highlight',
    icon: <span className={styles.toolMark}>H</span>,
  },
  {
    id: 'code',
    run: toggleInline('code'),
    pressed: 'code',
    icon: svg('M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4'),
  },
  {
    id: 'link',
    run: insertLink,
    open: openLinkPicker,
    icon: svg('M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1'),
  },
];
const BLOCK: Item[] = [
  {
    id: 'bullet',
    run: toggleBlock('bullet'),
    pressed: 'bullet',
    icon: svg('M3 4h.01M3 8h.01M3 12h.01M6 4h7M6 8h7M6 12h7'),
  },
  {
    id: 'numbered',
    run: toggleBlock('numbered'),
    pressed: 'numbered',
    icon: svg('M2.5 3.5h1v3M2.5 9.5h2l-2 2.5h2M6.5 4.5h7M6.5 11h7'),
  },
  {
    id: 'task',
    run: toggleBlock('task'),
    pressed: 'task',
    icon: svg('M2.5 3.5h4v4h-4zM3.5 5.5l1 1 1.5-2M9 5.5h4.5M2.5 10.5h4v3h-4zM9 12h4.5'),
  },
  {
    id: 'quote',
    run: toggleBlock('quote'),
    pressed: 'quote',
    icon: svg('M3 3.5v9M6 5h7M6 8h7M6 11h5'),
  },
  { id: 'divider', run: insertDivider, icon: svg('M2 8h12') },
];
const LEVELS = [0, 1, 2, 3, 4, 5, 6] as const;

/** The formatting toolbar (M2b §6): an ARIA toolbar with one Tab stop (arrow
 *  keys, Home and End move between controls); buttons show `aria-pressed`
 *  for the formats at the cursor and keep the editor's selection. */
export function Toolbar({ view, active }: { view: EditorView; active: Set<ActiveFormat> }) {
  const { t } = useTranslation();
  const bar = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const level = LEVELS.find((n) => n > 0 && active.has(`h${n}` as ActiveFormat)) ?? 0;

  const run = (cmd: StateCommand) => {
    cmd({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
    view.focus();
  };
  const controls = () => [...(bar.current?.querySelectorAll<HTMLElement>('[data-tool]') ?? [])];
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = controls();
    const at = all.indexOf(e.target as HTMLElement);
    if (at < 0) return;
    const next =
      e.key === 'ArrowRight'
        ? (at + 1) % all.length
        : e.key === 'ArrowLeft'
          ? (at - 1 + all.length) % all.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? all.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    setFocusIndex(next);
    all[next].focus();
  };
  let index = 0;
  const tab = () => (index++ === focusIndex ? 0 : -1);
  const button = (item: Item) => {
    const i = index;
    return (
      <button
        key={item.id}
        type="button"
        data-tool
        className={styles.tool}
        tabIndex={tab()}
        aria-label={t(`toolbar.${item.id}`)}
        title={t(`toolbar.${item.id}`)}
        aria-pressed={item.pressed ? active.has(item.pressed) : undefined}
        // Keep the editor's selection: the click runs on it.
        onMouseDown={(e) => e.preventDefault()}
        onFocus={() => setFocusIndex(i)}
        onClick={() => {
          if (!item.open?.(view)) run(item.run);
        }}
      >
        {item.icon}
      </button>
    );
  };

  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label={t('toolbar.label')}
      className={styles.toolbar}
      onKeyDown={onKeyDown}
    >
      {INLINE.map(button)}
      <span className={styles.toolSep} aria-hidden="true" />
      {(() => {
        const i = index;
        return (
          <select
            data-tool
            className={styles.toolSelect}
            tabIndex={tab()}
            aria-label={t('toolbar.heading')}
            value={level}
            onFocus={() => setFocusIndex(i)}
            onChange={(e) => run(setHeading(Number(e.target.value) as (typeof LEVELS)[number]))}
          >
            {LEVELS.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? t('toolbar.paragraph') : t('toolbar.headingN', { n })}
              </option>
            ))}
          </select>
        );
      })()}
      <span className={styles.toolSep} aria-hidden="true" />
      {BLOCK.map(button)}
    </div>
  );
}
