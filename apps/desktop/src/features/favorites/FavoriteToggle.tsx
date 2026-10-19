import { useTranslation } from 'react-i18next';
import { StarIcon } from './FavoritesSection';
import { useFavoritesStore } from './favoritesStore';
import styles from '../page/PageView.module.css';

/** The page header's star (M5b §19): adds the page to Favorites or takes it
 *  out (⌘⇧D). Archived pages have none. */
export function FavoriteToggle({ path }: { path: string }) {
  const { t } = useTranslation();
  const on = useFavoritesStore((s) => s.paths.includes(path));
  if (path.startsWith('.archive/')) return null;
  const label = t(on ? 'favorites.remove' : 'favorites.add');
  return (
    <button
      type="button"
      className={styles.toolbarToggle}
      aria-pressed={on}
      aria-label={label}
      aria-keyshortcuts="Meta+Shift+D Control+Shift+D"
      title={label}
      data-favorite-toggle
      onClick={() => void useFavoritesStore.getState().toggle(path)}
    >
      <StarIcon filled={on} size={15} />
    </button>
  );
}
