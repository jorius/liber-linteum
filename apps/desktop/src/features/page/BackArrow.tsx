import { useTranslation } from 'react-i18next';
import { goBack } from '../../stores/navigate';
import { useTrailStore } from '../../stores/trailStore';
import { nameOf } from '../../stores/tree';
import styles from './PageView.module.css';

/** ← back along the link trail (M2b §3), before the breadcrumb of a page or
 *  a text file (final review M9); nothing at the start of the trail. */
export function BackArrow() {
  const { t } = useTranslation();
  const previous = useTrailStore((s) => s.back[s.back.length - 1] ?? null);
  if (!previous) return null;
  const label = t('trail.back', { name: nameOf(previous.path).replace(/\.md$/i, '') });
  return (
    <button
      type="button"
      className={styles.back}
      aria-label={label}
      title={label}
      onClick={() => void goBack()}
    >
      <span aria-hidden="true">←</span>
    </button>
  );
}
