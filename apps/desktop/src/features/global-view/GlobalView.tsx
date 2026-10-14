import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PlusIcon } from '../../app/icons';
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
import { canvasKey, useGvStore } from './gvStore';
import { Toolbar } from './Toolbar';
import styles from './GlobalView.module.css';

/** Re-reading after vault changes waits for a burst to settle (M3a §9). */
export const REFRESH_MS = 150;

/** The Global View screen (M3a): the vault as cards, level by level. */
export function GlobalView() {
  const { t } = useTranslation();
  const mode = useSettingsStore((s) => s.settings.globalViewMode);
  const toggles = useSettingsStore((s) => s.settings.globalViewEdges);
  const stack = useGvStore((s) => s.stack);
  const loaded = useGvStore((s) => s.loaded);
  const empty = useGvStore((s) => s.canvas.cards.length === 0);
  const area = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1220);

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
   *  folder without one opens as the next level. */
  const onOpenEditor = useCallback((card: GvCard) => {
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
    <section className={styles.view} aria-label={t('gv.region')}>
      <Toolbar />
      <div ref={area} className={styles.area}>
        <ReactFlowProvider>
          <Canvas
            canvasKey={canvasKey(mode, stack[stack.length - 1])}
            mode={mode}
            toggles={toggles}
            width={width}
            onOpen={onOpen}
            onOpenEditor={onOpenEditor}
          />
        </ReactFlowProvider>
        {loaded && empty && <p className={styles.empty}>{t('gv.empty')}</p>}
        <button type="button" className={styles.fab} onClick={() => void newEntry()}>
          <PlusIcon />
          {t('gv.newEntry')}
        </button>
      </div>
    </section>
  );
}
