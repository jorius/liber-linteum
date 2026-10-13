import { useTranslation } from 'react-i18next';
import { nameOf, parentOf } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';
import styles from './PageView.module.css';

/** Vault › folders › page (M2a §5). Folder segments reveal and focus the folder
 *  in the explorer; the vault segment collapses the tree to the top. Shared
 *  with the Global View (GV-14). */
export function Breadcrumb({ path }: { path: string }) {
  const { t } = useTranslation();
  const vault = useVaultStore((s) => s.info?.name ?? '');
  const reveal = useVaultStore((s) => s.revealFolder);
  const folders: string[] = [];
  for (let p = parentOf(path); p; p = parentOf(p)) folders.unshift(p);
  return (
    <nav aria-label={t('page.breadcrumb')} className={styles.breadcrumb}>
      <ol>
        <li>
          <button type="button" onClick={() => reveal('')}>
            {vault}
          </button>
        </li>
        {folders.map((folder) => (
          <li key={folder}>
            <button type="button" onClick={() => reveal(folder)}>
              {nameOf(folder)}
            </button>
          </li>
        ))}
        <li>
          <span aria-current="page">{nameOf(path).replace(/\.md$/i, '')}</span>
        </li>
      </ol>
    </nav>
  );
}
