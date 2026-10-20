import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckIcon,
  CoverLeftIcon,
  CoverRightIcon,
  CoverTopIcon,
  ImagePlusIcon,
  MoveIcon,
  MoveVerticalIcon,
  SmallCloseIcon,
  SmallImageIcon,
  TrashIcon,
} from '../../app/icons';
import { assetUrl, coverPick, linksResolve, type CoverSide, type Page } from '../../ipc';
import { useCoverLayoutStore, useCoverSide } from '../../stores/coverLayoutStore';
import { useEditorStore } from '../../stores/editorStore';
import { errorMessage } from '../../stores/messages';
import { useToastStore } from '../../stores/toastStore';
import { useVaultStore } from '../../stores/vaultStore';
import { recordCoverSide } from '../editor/coverSideHistory';
import { useCoverResize } from './CoverResize';
import { useCoverWidthResize } from './CoverWidth';
import styles from './PageView.module.css';

/** `of`: the `cover:` value the state was resolved for. */
type CoverState =
  | { kind: 'none' }
  | { kind: 'loading'; of: string }
  | { kind: 'remote'; of: string }
  | { kind: 'missing'; of: string }
  | { kind: 'image'; path: string; of: string };

/** Where the page's `cover:` points (remote URLs are never loaded). */
function useCover(page: Page): CoverState {
  const [state, setState] = useState<CoverState>({ kind: 'none' });
  useEffect(() => {
    const cover = page.cover?.trim();
    if (!cover) {
      setState({ kind: 'none' });
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(cover)) {
      setState({ kind: 'remote', of: cover });
      return;
    }
    let live = true;
    setState({ kind: 'loading', of: cover });
    void linksResolve(page.path, [{ kind: 'cover', target: cover }]).then((res) => {
      if (!live) return;
      const path = res.ok ? res.value[0] : null;
      setState(path ? { kind: 'image', path, of: cover } : { kind: 'missing', of: cover });
    });
    return () => {
      live = false;
    };
  }, [page.path, page.cover]);
  return state;
}

/** The width of `ref`'s element, kept current (`null` until measured, or
 *  where there is no ResizeObserver). */
function useMeasuredWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[entries.length - 1]?.contentRect.width ?? 0;
      // A hidden page measures 0: nothing to decide from that.
      if (w > 0) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

const clamp = (v: number) => Math.min(100, Math.max(0, Math.round(v)));

/** The cover's focus point while repositioning: % from the left and top. */
interface Focus {
  x: number;
  y: number;
}

const SIDES: { side: CoverSide; label: string; Icon: () => ReactNode }[] = [
  { side: 'top', label: 'cover.placeTop', Icon: CoverTopIcon },
  { side: 'left', label: 'cover.placeLeft', Icon: CoverLeftIcon },
  { side: 'right', label: 'cover.placeRight', Icon: CoverRightIcon },
];

/** What the band's rows get from the cover: the "Add cover" button (no cover
 *  yet, editable page) and the cover's own controls, both placed by the rows. */
export interface CoverSlots {
  addCover: ReactNode;
  controls: ReactNode;
}

/** The page's header band (M4b §1) and its cover (M2c §2), around the rest
 *  of the page (`body`). With a cover on top, the image is the band's
 *  background and the rows sit on it; without one the band is plain. A cover
 *  on the left or right (M4b part 3 §3) is a tall strip beside the band and
 *  the text, holding the cover's controls; a window too narrow for it shows
 *  it on top instead. Add (upload), change, reposition, place and remove; a
 *  new cover opens in reposition mode at once (M4b §2). Without an editable
 *  document the cover is shown read-only. A cover band is as tall as the
 *  page's own cover height or the app's default, a strip as wide as its own
 *  width or 280 px; their inner edges resize them (kept in
 *  `.liber/vault.json`, so even a read-only page can). */
export function Cover({
  page,
  editable,
  body,
  children,
}: {
  page: Page;
  editable: boolean;
  /** The rest of the page: notices and the editor. */
  body?: ReactNode;
  children: (slots: CoverSlots) => ReactNode;
}) {
  const { t } = useTranslation();
  const cover = useCover(page);
  const resize = useCoverResize(page.path);
  const chosen = useCoverSide(page.path);
  const stripSide = chosen !== 'top' && cover.kind !== 'none' ? chosen : null;
  const layout = useRef<HTMLDivElement>(null);
  const available = useMeasuredWidth(layout);
  const strip = useCoverWidthResize(page.path, stripSide ?? 'left', available);
  const side = stripSide && strip.fits ? stripSide : null;

  const saved: Focus = { x: page.coverX ?? 50, y: page.coverY ?? 50 };
  const [draft, setDraft] = useState<Focus | null>(null);
  const slider = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startY: number; start: Focus } | null>(null);
  const focus = draft ?? saved;

  const reposition = useRef<HTMLButtonElement>(null);
  const repositioning = draft !== null;
  useEffect(() => setDraft(null), [page.path, page.cover, side]);
  // A cover just picked opens in reposition mode once its image shows, so it
  // is placed with one Save position (M4b §2). The pick removed the focus.
  const [placeNext, setPlaceNext] = useState<string | null>(null);
  useEffect(() => setPlaceNext(null), [page.path]);
  useEffect(() => {
    // Only once the picked value itself has resolved: before that the state
    // still describes the previous cover (or none).
    if (!placeNext || cover.kind === 'none' || cover.kind === 'loading') return;
    if (cover.of !== placeNext) return;
    setPlaceNext(null);
    if (cover.kind === 'image') {
      fromPick.current = true;
      setDraft({ x: 50, y: 50 });
    } else setRefocus('change');
  }, [placeNext, cover]);
  // Focus moves into the slider and back to "Reposition" (never lost). After
  // a pick it goes to the slider unless the user clicked or typed somewhere
  // while the dialog was being answered (WebKit doesn't focus a clicked
  // button, and the explorer may refocus its row, so where focus sits says
  // little about intent).
  const band = useRef<HTMLDivElement>(null);
  const stripEl = useRef<HTMLDivElement>(null);
  const fromPick = useRef(false);
  const movedOn = useRef(false);
  const entered = useRef(false);
  useEffect(() => {
    const active = document.activeElement;
    const inCover =
      !active ||
      active === document.body ||
      !!band.current?.contains(active) ||
      !!stripEl.current?.contains(active);
    if (repositioning && (inCover || (fromPick.current && !movedOn.current))) {
      slider.current?.focus();
    } else if (!repositioning && entered.current && inCover) reposition.current?.focus();
    fromPick.current = false;
    entered.current = repositioning;
  }, [repositioning]);

  // Add, Change and Remove swap the band, unmounting the focused button: once
  // the matching button renders, focus goes there (final review I3), unless the
  // user has moved focus elsewhere meanwhile.
  const addButton = useRef<HTMLButtonElement>(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const [refocus, setRefocus] = useState<'add' | 'change' | null>(null);
  useEffect(() => setRefocus(null), [page.path]);
  useEffect(() => {
    if (!refocus) return;
    const target = (refocus === 'add' ? addButton : changeButton).current;
    if (!target) return; // not rendered yet: the cover is still settling
    setRefocus(null);
    const active = document.activeElement;
    if (!active || active === document.body || active === target) target.focus();
  }, [refocus, cover.kind, editable, repositioning]);

  // Choosing a placement by keyboard keeps focus on the chosen radio, which
  // moves between the band and the strip as the cover does.
  const radios = useRef(new Map<CoverSide, HTMLButtonElement>());
  const [focusSide, setFocusSide] = useState<CoverSide | null>(null);
  useEffect(() => {
    if (!focusSide) return;
    setFocusSide(null);
    radios.current.get(focusSide)?.focus();
  }, [focusSide, side]);

  const edit = useEditorStore.getState().editFrontmatter;

  const pick = async () => {
    movedOn.current = false;
    const activity = () => {
      movedOn.current = true;
    };
    window.addEventListener('pointerdown', activity, true);
    window.addEventListener('keydown', activity, true);
    const res = await coverPick(page.path).finally(() => {
      window.removeEventListener('pointerdown', activity, true);
      window.removeEventListener('keydown', activity, true);
    });
    // The editor may have moved on while the dialog was open: `edit` changes
    // the current page, so the result is then dropped rather than written into
    // another page (final review M8). The image is in the vault already.
    const moved = useEditorStore.getState().path !== page.path;
    const settled = cover.kind === 'none' ? 'add' : 'change';
    if (!res.ok) {
      useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
      if (!moved) setRefocus(settled);
      return;
    }
    if (!res.value) {
      if (!moved) setRefocus(settled); // cancelled
      return;
    }
    if (!moved) {
      const ok = await edit({ cover: res.value.reference, 'cover-y': null, 'cover-x': null });
      if (ok) setPlaceNext(res.value.reference.trim());
      else setRefocus(settled);
    }
    void useVaultStore.getState().refreshTree();
  };
  const remove = async () => {
    if (await edit({ cover: null, 'cover-y': null, 'cover-x': null })) setRefocus('add');
  };
  const save = async () => {
    if (draft === null) return;
    const patch: Record<string, number> = {};
    if (draft.y !== saved.y) patch['cover-y'] = draft.y;
    if (side && draft.x !== saved.x) patch['cover-x'] = draft.x;
    if (Object.keys(patch).length > 0) await edit(patch);
    setDraft(null);
  };
  const place = (next: CoverSide) => {
    if (next === chosen) return;
    const from = chosen;
    void useCoverLayoutStore
      .getState()
      .saveSide(page.path, next)
      .then((ok) => {
        if (ok) recordCoverSide(page.path, from, next);
      });
  };
  const onRadioKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const at = SIDES.findIndex((s) => s.side === chosen);
    const next = SIDES[(at + step + SIDES.length) % SIDES.length].side;
    setFocusSide(next);
    place(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dy = { ArrowUp: 5, ArrowDown: -5, PageUp: 20, PageDown: -20 }[e.key];
    const dx = side ? { ArrowRight: 5, ArrowLeft: -5 }[e.key] : undefined;
    if (dy !== undefined || dx !== undefined) {
      e.preventDefault();
      setDraft((d) => {
        const at = d ?? saved;
        return { x: clamp(at.x + (dx ?? 0)), y: clamp(at.y + (dy ?? 0)) };
      });
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setDraft((d) => ({ x: (d ?? saved).x, y: e.key === 'Home' ? 0 : 100 }));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(null);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void save();
    }
  };
  // Dragging moves the visible slice with the pointer: down shows more of the
  // top, right more of the left (a top cover only moves up and down).
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { startX: e.clientX, startY: e.clientY, start: focus };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    const img = e.currentTarget.querySelector('img');
    const box = e.currentTarget.getBoundingClientRect();
    // `object-fit: cover` scales the image to cover the box; what spills
    // over on each axis is what dragging can bring into view.
    const scale =
      img && img.naturalWidth && img.naturalHeight
        ? Math.max(box.width / img.naturalWidth, box.height / img.naturalHeight)
        : 0;
    const overX = Math.max(1, (img?.naturalWidth ?? 0) * scale - box.width);
    const overY = scale
      ? Math.max(1, (img?.naturalHeight ?? 0) * scale - box.height)
      : Math.max(1, box.height);
    setDraft({
      x: side ? clamp(start.start.x - ((e.clientX - start.startX) / overX) * 100) : start.start.x,
      y: clamp(start.start.y - ((e.clientY - start.startY) / overY) * 100),
    });
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const addCover =
    editable && cover.kind === 'none' ? (
      <button
        ref={addButton}
        type="button"
        className={`btn btn-secondary btn-sm ${styles.addCover}`}
        onClick={() => void pick()}
      >
        <ImagePlusIcon />
        {t('cover.add')}
      </button>
    ) : null;

  const placement = (
    <div role="radiogroup" aria-label={t('cover.placement')} className={styles.placement}>
      {SIDES.map(({ side: s, label, Icon }) => (
        <button
          key={s}
          ref={(el) => {
            if (el) radios.current.set(s, el);
            else radios.current.delete(s);
          }}
          type="button"
          role="radio"
          aria-checked={chosen === s}
          aria-label={t(label)}
          title={t(label)}
          tabIndex={chosen === s ? 0 : -1}
          className={styles.placementOption}
          onClick={(e) => {
            // The group moves between the band and the strip: keep focus on it.
            if (document.activeElement === e.currentTarget) setFocusSide(s);
            place(s);
          }}
          onKeyDown={onRadioKey}
        >
          <Icon />
        </button>
      ))}
    </div>
  );

  const controls = editable && cover.kind !== 'none' && (
    <div className={styles.coverControls}>
      {repositioning ? (
        <>
          <span className={`${styles.pill} ${styles.repositionHint}`}>{t('cover.dragHint')}</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()}>
            <CheckIcon />
            {t('cover.save')}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDraft(null)}>
            <SmallCloseIcon />
            {t('cover.cancel')}
          </button>
        </>
      ) : (
        <>
          {placement}
          <button
            ref={changeButton}
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void pick()}
          >
            <SmallImageIcon />
            {t('cover.change')}
          </button>
          {cover.kind === 'image' && (
            <button
              ref={reposition}
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setDraft(saved)}
            >
              {side ? <MoveIcon /> : <MoveVerticalIcon />}
              {t('cover.reposition')}
            </button>
          )}
          <button type="button" className="btn btn-danger btn-sm" onClick={() => void remove()}>
            <TrashIcon />
            {t('cover.remove')}
          </button>
        </>
      )}
    </div>
  );

  const rows = (
    <div className={styles.bandRows}>
      {children({ addCover, controls: (!side && controls) || null })}
    </div>
  );

  // The cover itself: the image (a slider while repositioning), or a muted
  // layer saying why there is none. One wrapper either way, so the image
  // element survives entering the mode.
  let layer: ReactNode = null;
  if (cover.kind !== 'none' && cover.kind !== 'image') {
    layer = (
      <div className={styles.coverLayer}>
        {cover.kind !== 'loading' && (
          <p className={styles.coverPlaceholder}>
            {t(cover.kind === 'remote' ? 'cover.remote' : 'cover.missing')}
          </p>
        )}
      </div>
    );
  } else if (cover.kind === 'image') {
    const image = (
      <img
        data-cover
        className={styles.cover}
        src={assetUrl(cover.path)}
        alt=""
        draggable={false}
        style={{ objectPosition: `${focus.x}% ${focus.y}%` }}
      />
    );
    const sliderProps = repositioning
      ? {
          role: 'slider',
          tabIndex: 0,
          'aria-label': t('cover.position'),
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': focus.y,
          'aria-valuetext': side
            ? t('cover.positionBoth', { x: focus.x, y: focus.y })
            : t('cover.positionValue', { value: focus.y }),
          'aria-orientation': side ? undefined : ('vertical' as const),
          className: `${styles.coverLayer} ${styles.coverSlider} ${side ? styles.coverSliderBoth : ''}`,
          onKeyDown,
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
        }
      : { className: styles.coverLayer };
    layer = (
      <div ref={slider} {...sliderProps}>
        {image}
      </div>
    );
  }

  // One band element either way, so the title and subtitle in its rows
  // survive a cover being added or removed while they're being edited. The
  // rows stay pinned to the band's top and bottom at any height; the handle
  // steps aside while the image is being placed.
  const plain = cover.kind === 'none' || !!side;
  const header = (
    <div
      ref={band}
      data-band={plain ? 'plain' : 'cover'}
      role={plain ? undefined : 'group'}
      aria-label={plain ? undefined : t('cover.label')}
      className={
        plain
          ? styles.band
          : `${styles.band} ${styles.bandCover} ${repositioning ? styles.repositioning : ''}`
      }
      style={plain ? undefined : ({ '--cover-height': `${resize.height}px` } as CSSProperties)}
    >
      {plain ? null : layer}
      {rows}
      {plain || repositioning ? null : resize.handle}
    </div>
  );

  const stripNode = side && (
    <div
      ref={stripEl}
      data-cover-strip={side}
      role="group"
      aria-label={t('cover.label')}
      className={`${styles.strip} ${repositioning ? styles.repositioning : ''}`}
      style={{ '--cover-width': `${strip.width}px` } as CSSProperties}
    >
      {layer}
      {controls}
      {!repositioning && strip.handle}
    </div>
  );

  // The main column keeps its place whichever side the strip is on, so the
  // editor inside it is never remounted by a placement change.
  return (
    <div ref={layout} data-cover-layout className={styles.coverLayout}>
      {side === 'left' && stripNode}
      <div className={styles.coverMain}>
        {header}
        {body}
      </div>
      {side === 'right' && stripNode}
    </div>
  );
}
