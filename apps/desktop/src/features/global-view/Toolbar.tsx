import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { GlobalViewEdges, GvLevelRef } from '../../ipc';
import { HomeIcon, LinkIcon } from '../../app/icons';
import { useSettingsStore } from '../../stores/settingsStore';
import { useVaultStore } from '../../stores/vaultStore';
import { homeOffered, toggleGlobalViewHome, useHomeStore } from '../home/homeStore';
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

/** A level's name: "Vault", a folder's name, or a page's title (its file
 *  name until the level has loaded), as the breadcrumb shows it (M4b §1). */
export function levelLabel(ref: GvLevelRef, titles: Record<string, string>, t: TFunction): string {
  if (ref.kind === 'vault') return t('gv.vault');
  if (ref.kind === 'folder') return nameOf(ref.path);
  return titles[ref.path] ?? nameOf(ref.path).replace(/\.md$/i, '');
}

/** Breadcrumb, Drill-down | Expand in place, edge toggles and Reset layout
 *  (M3a §5–§7; prototype `.gvbar`). */
export function Toolbar() {
  const { t } = useTranslation();
  const stack = useGvStore((s) => s.stack);
  const titles = useGvStore((s) => s.titles);
  const connecting = useGvStore((s) => s.connectPick || s.connectFrom !== null);
  const atoms = useGvStore((s) => s.atoms);
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const mode = settings.globalViewMode;
  const toggles = settings.globalViewEdges;
  const isHome = useHomeStore((s) => s.home?.kind === 'globalView');
  const offersHome = useVaultStore((s) => homeOffered(s.info));

  const crumbLabel = (ref: GvLevelRef) => levelLabel(ref, titles, t);
  // Expand canvases show only their root level in the breadcrumb (M3a §5).
  const crumbs = stack;

  return (
    <div className={styles.toolbar}>
      <nav className={styles.crumbs} aria-label={t('gv.breadcrumb')}>
        <ol>
          {crumbs.map((ref, i) => {
            // With atoms shown (M4b part 3 §6), every level is a way back.
            const last = !atoms && i === crumbs.length - 1;
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
          {atoms && (
            <>
              <li>
                <button
                  type="button"
                  className={styles.crumb}
                  onClick={() => void useGvStore.getState().atomsPageLevel()}
                >
                  {atoms.title}
                </button>
              </li>
              <li>
                <span className={styles.crumbHere} aria-current="page">
                  {t('gv.atoms.crumb')}
                </span>
              </li>
            </>
          )}
        </ol>
      </nav>
      {/* The atoms map is read-only and has one layout: no mode, no
          connecting. */}
      {!atoms && (
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
      )}
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
              {/* The legend (M4b part 3 §5): each kind's line as drawn —
                  parent/child as an elbow. */}
              <svg width="30" height="12" aria-hidden="true" data-gv-sample={key}>
                <path
                  d={kind === 'tree' ? 'M3,1.5V6H27V10.5' : 'M2,6H28'}
                  style={{
                    fill: 'none',
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
      {!atoms && (
        <button
          type="button"
          className={styles.connect}
          data-gv-connect=""
          aria-pressed={connecting}
          onClick={() => {
            const gv = useGvStore.getState();
            if (connecting) gv.cancelConnect();
            else gv.startConnectPick();
          }}
        >
          <LinkIcon />
          {t('gv.relations.connectCards')}
        </button>
      )}
      {/* The vault's home: open on the Global View (a pressed toggle). */}
      {offersHome && (
        <button
          type="button"
          className={styles.connect}
          data-gv-home=""
          aria-pressed={isHome}
          title={t(isHome ? 'home.globalViewRemoveHint' : 'home.globalViewSetHint')}
          onClick={() => void toggleGlobalViewHome()}
        >
          <HomeIcon />
          {t('home.globalViewToggle')}
        </button>
      )}
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
