import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { assetUrl, coverPick, linksResolve, type Page } from '../../ipc';
import { useEditorStore } from '../../stores/editorStore';
import { errorMessage } from '../../stores/messages';
import { useToastStore } from '../../stores/toastStore';
import { useVaultStore } from '../../stores/vaultStore';
import styles from './PageView.module.css';

type CoverState =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'remote' }
  | { kind: 'missing' }
  | { kind: 'image'; path: string };

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
      setState({ kind: 'remote' });
      return;
    }
    let live = true;
    setState({ kind: 'loading' });
    void linksResolve(page.path, [{ kind: 'cover', target: cover }]).then((res) => {
      if (!live) return;
      const path = res.ok ? res.value[0] : null;
      setState(path ? { kind: 'image', path } : { kind: 'missing' });
    });
    return () => {
      live = false;
    };
  }, [page.path, page.cover]);
  return state;
}

const clamp = (y: number) => Math.min(100, Math.max(0, Math.round(y)));

/** The page cover (M2c §2): add (upload), change, reposition, remove. Without
 *  an editable document it is shown read-only. */
export function Cover({ page, editable }: { page: Page; editable: boolean }) {
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
  // Focus moves into the slider and back to "Reposition" (never lost).
  const entered = useRef(false);
  useEffect(() => {
    if (repositioning) slider.current?.focus();
    else if (entered.current) reposition.current?.focus();
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
    const res = await coverPick(page.path);
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
      setRefocus(ok ? 'change' : settled);
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

  if (cover.kind === 'none') {
    return editable ? (
      <button ref={addButton} type="button" className={styles.addCover} onClick={() => void pick()}>
        {t('cover.add')}
      </button>
    ) : null;
  }

  const controls = editable && (
    <div className={styles.coverControls}>
      {repositioning ? (
        <>
          <button type="button" className={styles.coverButton} onClick={() => void save()}>
            {t('cover.save')}
          </button>
          <button type="button" className={styles.coverButton} onClick={() => setDraft(null)}>
            {t('cover.cancel')}
          </button>
        </>
      ) : (
        <>
          <button
            ref={changeButton}
            type="button"
            className={styles.coverButton}
            onClick={() => void pick()}
          >
            {t('cover.change')}
          </button>
          {cover.kind === 'image' && (
            <button
              ref={reposition}
              type="button"
              className={styles.coverButton}
              onClick={() => setDraft(saved)}
            >
              {t('cover.reposition')}
            </button>
          )}
          <button type="button" className={styles.coverButton} onClick={() => void remove()}>
            {t('cover.remove')}
          </button>
        </>
      )}
    </div>
  );

  // Every band has the same shape (body, then controls), so the controls stay
  // mounted while a changed cover loads and a focused button keeps focus.
  if (cover.kind !== 'image') {
    return (
      <div role="group" aria-label={t('cover.label')} className={styles.coverBand}>
        {cover.kind === 'loading' ? (
          <div className={styles.coverFrame} />
        ) : (
          <p className={styles.coverPlaceholder}>
            {t(cover.kind === 'remote' ? 'cover.remote' : 'cover.missing')}
          </p>
        )}
        {controls}
      </div>
    );
  }
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
  // One wrapper either way, so the image element survives entering the mode.
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
        className: styles.coverSlider,
        onKeyDown,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: onPointerUp,
      }
    : { className: styles.coverFrame };
  return (
    <div role="group" aria-label={t('cover.label')} className={styles.coverBand}>
      <div ref={slider} {...sliderProps}>
        {image}
      </div>
      {controls}
    </div>
  );
}
