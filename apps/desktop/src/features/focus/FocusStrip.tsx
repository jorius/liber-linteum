import { useEffect, useState } from 'react';
import { useEditorStore } from '../../stores/editorStore';
import { usePageStore } from '../../stores/pageStore';
import { isImagePath, isTextPath } from '../../stores/textFiles';
import { useUiStore } from '../../stores/uiStore';
import { BackArrow } from '../page/BackArrow';
import { SaveStatus } from '../page/SaveStatus';
import { TextStats } from '../page/TextView';
import { WordCount } from '../page/WordCount';
import styles from './Focus.module.css';

/** The pointer this close to the bottom edge brings the strip up. */
const NEAR_PX = 64;

/** Focus mode's one row at the bottom (spec §4): ←, the count and the save
 *  status, faint until the pointer or the keyboard comes near. */
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
    </div>
  );
}
