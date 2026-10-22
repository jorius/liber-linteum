import type { StateCommand } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CheckIcon } from '../../app/icons';
import styles from './Editor.module.css';
import { insertTable, tableAction, tableInfo, type TableAction } from './tableEdit';

const COLS = 8;
const ROWS = 6;

/** The Format bar's Table button: outside a table it opens a size picker that
 *  inserts one; inside a table, the table menu (rows, columns, alignment,
 *  delete). Escape or Tab closes either and gives the keyboard back. */
export function TableTool({
  view,
  inTable,
  tabIndex,
  onFocus,
}: {
  view: EditorView;
  inTable: boolean;
  tabIndex: number;
  onFocus: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);
  const run = (cmd: StateCommand) => {
    setOpen(false);
    cmd({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
    view.focus();
  };
  const label = inTable ? t('toolbar.tableActions.menu') : t('toolbar.table');
  return (
    <>
      <button
        ref={button}
        type="button"
        data-tool
        className={styles.tool}
        tabIndex={tabIndex}
        aria-label={label}
        title={label}
        aria-haspopup={inTable ? 'menu' : 'dialog'}
        aria-expanded={open}
        aria-pressed={inTable}
        onMouseDown={(e) => e.preventDefault()}
        onFocus={onFocus}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown') return;
          e.preventDefault();
          setOpen(true);
        }}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path
            d="M2.5 3.5h11v9h-11zM2.5 6.5h11M2.5 9.5h11M6.2 3.5v9M9.8 3.5v9"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open &&
        button.current &&
        (inTable ? (
          <TableMenu anchor={button.current} view={view} onRun={run} onClose={close} />
        ) : (
          <SizePicker
            anchor={button.current}
            onPick={(cols, rows) => run(insertTable(cols, rows))}
            onClose={close}
          />
        ))}
    </>
  );
}

/** Closes on a press outside the popup and its button. */
function useOutside(
  box: RefObject<HTMLElement | null>,
  anchor: HTMLElement,
  onClose: (refocus: boolean) => void,
) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!box.current?.contains(target) && !anchor.contains(target)) onClose(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [box, anchor, onClose]);
}

const placeUnder = (anchor: HTMLElement) => {
  const rect = anchor.getBoundingClientRect();
  return { position: 'fixed' as const, left: Math.max(8, rect.left), top: rect.bottom + 4 };
};

/** A grid of cells: the one pointed at (or moved to with the arrows) and
 *  every cell above and left of it light up; a click or Enter inserts a table
 *  that size, its header row counted. */
function SizePicker({
  anchor,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  onPick: (cols: number, rows: number) => void;
  onClose: (refocus: boolean) => void;
}) {
  const { t } = useTranslation();
  const [at, setAt] = useState({ col: 2, row: 2 });
  const box = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  useOutside(box, anchor, onClose);
  useEffect(() => {
    refs.current[(at.row - 1) * COLS + at.col - 1]?.focus();
  }, [at]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const clamp = (v: number, max: number) => Math.max(1, Math.min(max, v));
    if (e.key === 'ArrowRight') setAt((p) => ({ ...p, col: clamp(p.col + 1, COLS) }));
    else if (e.key === 'ArrowLeft') setAt((p) => ({ ...p, col: clamp(p.col - 1, COLS) }));
    else if (e.key === 'ArrowDown') setAt((p) => ({ ...p, row: clamp(p.row + 1, ROWS) }));
    else if (e.key === 'ArrowUp') setAt((p) => ({ ...p, row: clamp(p.row - 1, ROWS) }));
    else if (e.key === 'Escape' || e.key === 'Tab') onClose(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-label={t('toolbar.tableActions.insert')}
      className={`liber-menu ${styles.tablePicker}`}
      style={placeUnder(anchor)}
      onKeyDown={onKeyDown}
    >
      <div className={styles.tableGrid} role="group" aria-label={t('toolbar.tableActions.insert')}>
        {Array.from({ length: ROWS * COLS }, (_, i) => {
          const row = Math.floor(i / COLS) + 1;
          const col = (i % COLS) + 1;
          const lit = row <= at.row && col <= at.col;
          return (
            <button
              key={i}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              className={styles.tableCell}
              data-lit={lit || undefined}
              tabIndex={row === at.row && col === at.col ? 0 : -1}
              aria-label={t('toolbar.tableActions.cell', { cols: col, rows: row })}
              onMouseEnter={() => setAt({ col, row })}
              onClick={() => onPick(col, row)}
            />
          );
        })}
      </div>
      <p className={styles.tableSize} aria-hidden="true">
        {t('toolbar.tableActions.size', { cols: at.col, rows: at.row })}
      </p>
    </div>,
    document.body,
  );
}

type Entry = { action: TableAction; radio?: true } | 'separator';
const ENTRIES: Entry[] = [
  { action: 'rowAbove' },
  { action: 'rowBelow' },
  { action: 'colLeft' },
  { action: 'colRight' },
  'separator',
  { action: 'alignLeft', radio: true },
  { action: 'alignCenter', radio: true },
  { action: 'alignRight', radio: true },
  'separator',
  { action: 'deleteRow' },
  { action: 'deleteCol' },
  { action: 'deleteTable' },
];
const ALIGNED: Partial<Record<TableAction, string>> = {
  alignLeft: 'left',
  alignCenter: 'center',
  alignRight: 'right',
};

/** The table menu (ARIA menu): arrows, Home and End move over the items. */
function TableMenu({
  anchor,
  view,
  onRun,
  onClose,
}: {
  anchor: HTMLElement;
  view: EditorView;
  onRun: (cmd: StateCommand) => void;
  onClose: (refocus: boolean) => void;
}) {
  const { t } = useTranslation();
  const info = tableInfo(view.state);
  const items = ENTRIES.filter((e): e is Exclude<Entry, 'separator'> => e !== 'separator');
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  useOutside(box, anchor, onClose);
  useEffect(() => {
    refs.current[active]?.focus();
  }, [active]);
  // The table went away under the menu (the page changed): nothing to do.
  useEffect(() => {
    if (!info) onClose(true);
  }, [info, onClose]);
  if (!info) return null;

  const count = items.length;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') setActive((a) => (a + 1) % count);
    else if (e.key === 'ArrowUp') setActive((a) => (a - 1 + count) % count);
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(count - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') onClose(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  let index = 0;
  return createPortal(
    <div
      ref={box}
      role="menu"
      aria-label={t('toolbar.tableActions.menu')}
      className="liber-menu"
      style={placeUnder(anchor)}
      onKeyDown={onKeyDown}
    >
      {ENTRIES.map((entry, k) => {
        if (entry === 'separator') return <div key={k} role="separator" />;
        const i = index++;
        const disabled = info.disabled.has(entry.action);
        const checked = entry.radio ? info.align === ALIGNED[entry.action] : undefined;
        return (
          <button
            key={entry.action}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role={entry.radio ? 'menuitemradio' : 'menuitem'}
            aria-checked={checked}
            aria-disabled={disabled || undefined}
            tabIndex={i === active ? 0 : -1}
            onClick={() => {
              if (!disabled) onRun(tableAction(entry.action));
            }}
          >
            <span className={styles.tableCheck}>{checked && <CheckIcon />}</span>
            {t(`toolbar.tableActions.${entry.action}`)}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
