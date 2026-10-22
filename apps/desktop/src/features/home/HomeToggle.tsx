import { useTranslation } from 'react-i18next';
import { HomeIcon } from '../../app/icons';
import { fileWindowName } from '../../ipc';
import { useVaultStore } from '../../stores/vaultStore';
import styles from '../page/PageView.module.css';
import { homeOffered, homePageOf, toggleHomePage, useHomeStore } from './homeStore';

/** The page header's house, beside the Favorites star: makes the page the
 *  vault's home, or stops it being one. Not in a file window (no vault) or
 *  the global Scratchpad, nor on archived pages (the header leaves it out). */
export function HomeToggle({ path }: { path: string }) {
  const { t } = useTranslation();
  const on = useHomeStore((s) => homePageOf(s.home) === path);
  const offered = useVaultStore((s) => homeOffered(s.info));
  if (!offered || fileWindowName() !== null) return null;
  const label = t(on ? 'home.removePage' : 'home.setPage');
  return (
    <button
      type="button"
      className={`${styles.toolbarToggle} ${styles.homeToggle}`}
      aria-pressed={on}
      aria-label={label}
      title={label}
      data-home-toggle
      onClick={() => void toggleHomePage(path)}
    >
      <HomeIcon size={15} />
    </button>
  );
}
