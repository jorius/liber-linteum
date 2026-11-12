import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMediaQuery } from '../../app/useMediaQuery';
import { useSettingsStore } from '../../stores/settingsStore';
import { toggleNight } from '../../stores/menuToggles';
import { useEditorStore } from '../../stores/editorStore';
import { usePageStore } from '../../stores/pageStore';
import { isImagePath, isTextPath } from '../../stores/textFiles';
import { useUiStore } from '../../stores/uiStore';
import { BackArrow } from '../page/BackArrow';
import pageStyles from '../page/PageView.module.css';
import { SaveStatus } from '../page/SaveStatus';
import { TextStats } from '../page/TextView';
import { WordCount } from '../page/WordCount';
import styles from './Focus.module.css';

/** The pointer this close to the bottom edge brings the strip up. */
const NEAR_PX = 64;

/** Focus mode's one row at the bottom (spec §4): ←, the count, the save
 *  status and light / dark, faint until the pointer or the keyboard comes near. */
export function FocusStrip() {
  const focus = useUiStore((s) => s.focus);
  const path = usePageStore((s) => s.path);
  const hasDoc = useEditorStore((s) => s.doc !== null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!focus) return;
    const onMove = (e: PointerEvent) => setNear(window.innerHeight - e.clientY <= NEAR_PX);
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [focus]);
  if (!focus) return null;
  const image = path !== null && isImagePath(path);
  return (
    <div data-focus-strip className={styles.strip} data-near={near || undefined}>
      <BackArrow />
      {!image && hasDoc && (
        <>
          {path !== null && isTextPath(path) ? <TextStats /> : <WordCount />}
          <SaveStatus />
        </>
      )}
      <NightButton />
    </div>
  );
}

/** Light ↔ dark (night mode) without leaving Focus mode. */
function NightButton() {
  const { t } = useTranslation();
  const theme = useSettingsStore((s) => s.settings.theme);
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  const label = t(dark ? 'focus.toLight' : 'focus.toDark');
  return (
    <button
      type="button"
      className={pageStyles.back}
      aria-label={label}
      title={label}
      onClick={toggleNight}
    >
      <span aria-hidden="true">{dark ? '☀' : '☾'}</span>
    </button>
  );
}
