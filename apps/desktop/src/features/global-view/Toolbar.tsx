import { useTranslation } from 'react-i18next';
import type { GlobalViewEdges, GvLevelRef } from '../../ipc';
import { useSettingsStore } from '../../stores/settingsStore';
import { nameOf } from '../../stores/tree';
import { strokeOf, type GvEdgeKind } from './edges';
import { levelKey, useGvStore } from './gvStore';
import styles from './GlobalView.module.css';

const TOGGLES: { key: keyof GlobalViewEdges; kind: GvEdgeKind; aggregated: boolean }[] = [
  { key: 'links', kind: 'link', aggregated: false },
  { key: 'tree', kind: 'tree', aggregated: false },
  { key: 'manual', kind: 'manual', aggregated: false },
  { key: 'aggregated', kind: 'link', aggregated: true },
];

/** Breadcrumb, Drill-down | Expand in place, edge toggles and Reset layout
 *  (M3a §5–§7; prototype `.gvbar`). */
export function Toolbar() {
  const { t } = useTranslation();
  const stack = useGvStore((s) => s.stack);
  const levels = useGvStore((s) => s.levels);
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const mode = settings.globalViewMode;
  const toggles = settings.globalViewEdges;

  const crumbLabel = (ref: GvLevelRef) => {
    if (ref.kind === 'vault') return t('gv.vault');
    if (ref.kind === 'folder') return nameOf(ref.path);
    const centre = levels[levelKey(ref)]?.cards.find((c) => c.path === ref.path);
    return centre?.title ?? nameOf(ref.path).replace(/\.md$/i, '');
  };
  // Expand canvases show only their root level in the breadcrumb (M3a §5).
  const crumbs = stack;

  return (
    <div className={styles.toolbar}>
      <nav className={styles.crumbs} aria-label={t('gv.breadcrumb')}>
        <ol>
          {crumbs.map((ref, i) => {
            const last = i === crumbs.length - 1;
            return (
              <li key={`${i}:${levelKey(ref)}`}>
                {last ? (
                  <span className={styles.crumbHere} aria-current="page">
                    {crumbLabel(ref)}
                  </span>
                ) : (
                  <button
                    type="button"
                    className={styles.crumb}
                    onClick={() => void useGvStore.getState().back(i)}
                  >
                    {crumbLabel(ref)}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      <div className={styles.seg} role="group" aria-label={t('gv.mode')}>
        {(['drill', 'expand'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            className={mode === m ? styles.segOn : undefined}
            onClick={() => void update({ globalViewMode: m })}
          >
            {t(`gv.${m}`)}
          </button>
        ))}
      </div>
      <div className={styles.chips} role="group" aria-label={t('gv.edges')}>
        {TOGGLES.map(({ key, kind, aggregated }) => {
          const s = strokeOf(kind, aggregated);
          return (
            <button
              key={key}
              type="button"
              className={styles.chip}
              aria-pressed={toggles[key]}
              onClick={() => void update({ globalViewEdges: { ...toggles, [key]: !toggles[key] } })}
            >
              <svg width="20" height="6" aria-hidden="true">
                <line
                  x1="1"
                  y1="3"
                  x2="19"
                  y2="3"
                  style={{
                    stroke: s.stroke,
                    strokeWidth: Math.min(s.width, 3),
                    strokeDasharray: s.dash,
                    strokeLinecap: 'round',
                  }}
                />
              </svg>
              {t(`gv.edge.${key}`)}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className={styles.reset}
        onClick={() => void useGvStore.getState().resetLayout()}
      >
        {t('gv.reset')}
      </button>
    </div>
  );
}
