import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckIcon,
  ImagePlusIcon,
  MoveVerticalIcon,
  SmallCloseIcon,
  SmallImageIcon,
  TrashIcon,
} from '../../app/icons';
import { assetUrl, coverPick, linksResolve, type Page } from '../../ipc';
import { useEditorStore } from '../../stores/editorStore';
import { errorMessage } from '../../stores/messages';
import { useToastStore } from '../../stores/toastStore';
import { useVaultStore } from '../../stores/vaultStore';
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

const clamp = (y: number) => Math.min(100, Math.max(0, Math.round(y)));

/** What the band's rows get from the cover: the "Add cover" button (no cover
 *  yet, editable page) and the cover's own controls, both placed by the rows. */
export interface CoverSlots {
  addCover: ReactNode;
  controls: ReactNode;
}

/** The page's header band (M4b §1) and its cover (M2c §2): with a cover, the
 *  image is the band's background and the rows sit on it; without one the
 *  band is plain. Add (upload), change, reposition and remove; a new cover
 *  opens in reposition mode at once (M4b §2). Without an editable document
 *  the cover is shown read-only. */
export function Cover({
  page,
  editable,
  children,
}: {
  page: Page;
  editable: boolean;
  children: (slots: CoverSlots) => ReactNode;
}) {
  const { t } = useTranslation();
  const cover = useCover(page);
  const saved = page.coverY ?? 50;
  const [draft, setDraft] = useState<number | null>(null);
  const slider = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; startValue: number } | null>(null);
  const y = draft ?? saved;

  const reposition = useRef<HTMLButtonElement>(null);
  const repositioning = draft !== null;
  useEffect(() => setDraft(null), [page.path, page.cover]);
  // A cover just picked opens in reposition mode once its image shows, so it
  // is placed with one Save position (M4b §2). The pick removed `cover-y`.
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
      setDraft(50);
    } else setRefocus('change');
  }, [placeNext, cover]);
  // Focus moves into the slider and back to "Reposition" (never lost). After
  // a pick it goes to the slider unless the user clicked or typed somewhere
  // while the dialog was being answered (WebKit doesn't focus a clicked
  // button, and the explorer may refocus its row, so where focus sits says
  // little about intent).
  const band = useRef<HTMLDivElement>(null);
  const fromPick = useRef(false);
  const movedOn = useRef(false);
  const entered = useRef(false);
  useEffect(() => {
    const active = document.activeElement;
    const inBand = !active || active === document.body || !!band.current?.contains(active);
    if (repositioning && (inBand || (fromPick.current && !movedOn.current))) {
      slider.current?.focus();
    } else if (!repositioning && entered.current && inBand) reposition.current?.focus();
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
      const ok = await edit({ cover: res.value.reference, 'cover-y': null });
      if (ok) setPlaceNext(res.value.reference.trim());
      else setRefocus(settled);
    }
    void useVaultStore.getState().refreshTree();
  };
  const remove = async () => {
    if (await edit({ cover: null, 'cover-y': null })) setRefocus('add');
  };
  const save = async () => {
    if (draft === null) return;
    const value = draft;
    if (value !== saved) await edit({ 'cover-y': value });
    setDraft(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowUp: 5, ArrowDown: -5, PageUp: 20, PageDown: -20 }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      setDraft((d) => clamp((d ?? saved) + step));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setDraft(e.key === 'Home' ? 0 : 100);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(null);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void save();
    }
  };
  // Dragging moves the visible slice with the pointer: down shows more of the top.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { startY: e.clientY, startValue: y };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    const img = e.currentTarget.querySelector('img');
    const band = e.currentTarget.getBoundingClientRect();
    const rendered =
      img && img.naturalWidth ? (img.naturalHeight * band.width) / img.naturalWidth : band.height;
    const overflow = Math.max(1, rendered - band.height);
    setDraft(clamp(start.startValue - ((e.clientY - start.startY) / overflow) * 100));
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
              <MoveVerticalIcon />
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
    <div className={styles.bandRows}>{children({ addCover, controls: controls || null })}</div>
  );
  if (cover.kind === 'none') {
    return (
      <div ref={band} data-band="plain" className={styles.band}>
        {rows}
      </div>
    );
  }

  // The background: the image (a slider while repositioning), or a muted
  // band saying why there is none. One wrapper either way, so the image
  // element survives entering the mode.
  let layer: ReactNode;
  if (cover.kind !== 'image') {
    layer = (
      <div className={styles.coverLayer}>
        {cover.kind !== 'loading' && (
          <p className={styles.coverPlaceholder}>
            {t(cover.kind === 'remote' ? 'cover.remote' : 'cover.missing')}
          </p>
        )}
      </div>
    );
  } else {
    const image = (
      <img
        data-cover
        className={styles.cover}
        src={assetUrl(cover.path)}
        alt=""
        draggable={false}
        style={{ objectPosition: `50% ${y}%` }}
      />
    );
    const sliderProps = repositioning
      ? {
          role: 'slider',
          tabIndex: 0,
          'aria-label': t('cover.position'),
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': y,
          'aria-valuetext': t('cover.positionValue', { value: y }),
          'aria-orientation': 'vertical' as const,
          className: `${styles.coverLayer} ${styles.coverSlider}`,
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
  return (
    <div
      ref={band}
      data-band="cover"
      role="group"
      aria-label={t('cover.label')}
      className={`${styles.band} ${styles.bandCover} ${repositioning ? styles.repositioning : ''}`}
    >
      {layer}
      {rows}
    </div>
  );
}
