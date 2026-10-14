import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LinkIcon, PlusIcon } from '../../app/icons';
import { entryCreatePage, type GvCard } from '../../ipc';
import { useEditorStore } from '../../stores/editorStore';
import { errorMessage } from '../../stores/messages';
import { openNewPage, openPage } from '../../stores/navigate';
import { usePageStore } from '../../stores/pageStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { nextFreeName } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';
import { Canvas } from './Canvas';
import { useGvStore } from './gvStore';
import { Toolbar } from './Toolbar';
import styles from './GlobalView.module.css';

/** Re-reading after vault changes waits for a burst to settle (M3a §9). */
export const REFRESH_MS = 150;

/** The Global View screen (M3a): the vault as cards, level by level. */
export function GlobalView() {
  const { t } = useTranslation();
  const mode = useSettingsStore((s) => s.settings.globalViewMode);
  const toggles = useSettingsStore((s) => s.settings.globalViewEdges);
  const loaded = useGvStore((s) => s.loaded);
  const empty = useGvStore((s) => s.canvas.cards.length === 0);
  const shownKey = useGvStore((s) => s.shownKey);
  const connectFrom = useGvStore((s) => s.connectFrom);
  // A hub page's neighbourhood is capped (final review m14): say how many
  // linked pages the level leaves out.
  const omitted = useGvStore((s) => (s.shownKey ? (s.levels[s.shownKey]?.omitted ?? 0) : 0));
  const region = useRef<HTMLElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const emptyNote = useRef<HTMLParagraphElement>(null);
  const [width, setWidth] = useState(1220);

  // Leaving for the editor with the keyboard in here: the editor takes it
  // when it shows (a page opened from a card, ⌘1), unless New entry asked
  // for the title (M3a final review I4). A layout cleanup: the view is still
  // in the document.
  useLayoutEffect(
    () => () => {
      const pages = usePageStore.getState();
      if (region.current?.contains(document.activeElement) && !pages.titleFocus) {
        pages.requestEditorFocus();
      }
    },
    [],
  );

  // An empty level has no card to take the keyboard: the note does, and
  // Escape there goes back up (I4).
  useEffect(() => {
    if (!loaded || !empty) return;
    const active = document.activeElement;
    const lost = !active || active === document.body || active.closest('[hidden]') !== null;
    if (lost || area.current?.contains(active)) emptyNote.current?.focus();
  }, [loaded, empty, shownKey]);

  // Load on show; re-read when the vault or a saved page changes.
  useEffect(() => {
    void useGvStore.getState().load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void useGvStore.getState().load(), REFRESH_MS);
    };
    const stopVault = useVaultStore.subscribe((s, p) => {
      if (s.nodes !== p.nodes) later();
    });
    const stopEditor = useEditorStore.subscribe((s, p) => {
      if (s.hash !== p.hash) later();
    });
    return () => {
      clearTimeout(timer);
      stopVault();
      stopEditor();
    };
  }, []);

  // A new mode keeps the root level and forgets expansions (M3a §5).
  const firstMode = useRef(mode);
  useEffect(() => {
    if (mode === firstMode.current) return;
    firstMode.current = mode;
    void useGvStore.getState().modeChanged();
  }, [mode]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth || el.offsetWidth || 1220));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const onOpen = useCallback((card: GvCard) => void useGvStore.getState().open(card), []);
  /** Double click / See all (GV-12): the page, or a folder's index note; a
   *  folder without one opens as the next level. In connect mode it picks
   *  the card (M3b §2). */
  const onOpenEditor = useCallback((card: GvCard) => {
    if (useGvStore.getState().connectFrom) {
      void useGvStore.getState().completeConnect(card);
      return;
    }
    const page = card.kind === 'page' ? card.path : card.indexPage;
    if (page) void openPage(page);
    else void useGvStore.getState().open(card);
  }, []);

  /** GV-17: "Untitled" in the folder shown, opened with its name selected. */
  const newEntry = async () => {
    const dir = useGvStore.getState().entryDir();
    const name = nextFreeName(useVaultStore.getState().nodes, dir, t('explorer.untitled'), '.md');
    const res = await entryCreatePage(dir, name);
    if (!res.ok) {
      useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
      return;
    }
    usePageStore.getState().requestTitleFocus(res.value);
    await openNewPage(res.value);
  };

  return (
    <section ref={region} className={styles.view} aria-label={t('gv.region')}>
      <Toolbar />
      {connectFrom && (
        <div className={styles.connectBar}>
          <LinkIcon />
          <p role="status" aria-label={t('gv.relations.connecting')} className={styles.connectText}>
            {t('gv.relations.pick', { name: connectFrom.title })}
          </p>
          <button type="button" onClick={() => useGvStore.getState().cancelConnect()}>
            {t('dialogs.cancel')}
          </button>
        </div>
      )}
      <div ref={area} className={styles.area}>
        <ReactFlowProvider>
          <Canvas
            mode={mode}
            toggles={toggles}
            width={width}
            onOpen={onOpen}
            onOpenEditor={onOpenEditor}
          />
        </ReactFlowProvider>
        {loaded && empty && (
          <p
            ref={emptyNote}
            className={styles.empty}
            tabIndex={-1}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              e.preventDefault();
              void useGvStore.getState().up(null);
            }}
          >
            {t('gv.empty')}
          </p>
        )}
        {loaded && omitted > 0 && (
          <p role="status" className={styles.omitted}>
            {t('gv.omitted', { count: omitted })}
          </p>
        )}
        <button type="button" className={styles.fab} onClick={() => void newEntry()}>
          <PlusIcon />
          {t('gv.newEntry')}
        </button>
      </div>
    </section>
  );
}
