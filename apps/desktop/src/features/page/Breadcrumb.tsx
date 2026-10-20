import { useTranslation } from 'react-i18next';
import { isFolderPage, nameOf, parentOf } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';
import { ItemIcon, useIcons } from '../icons/ItemIcon';
import styles from './PageView.module.css';

/** Vault › folders › page (M2a §5). Folder segments reveal and focus the folder
 *  in the explorer; the vault segment collapses the tree to the top. Shared
 *  with the Global View (GV-14). */
export function Breadcrumb({ path }: { path: string }) {
  const { t } = useTranslation();
  const vault = useVaultStore((s) => s.info?.name ?? '');
  const reveal = useVaultStore((s) => s.revealFolder);
  const vaultIcon = useVaultStore((s) => s.info?.icon);
  const icons = useIcons();
  const folders: string[] = [];
  for (let p = parentOf(path); p; p = parentOf(p)) folders.unshift(p);
  // A folder page (round 3b §6.5) is its folder: `… / X`, not `… / X / X`.
  const folderPage = isFolderPage(path);
  if (folderPage) folders.pop();
  const page = nameOf(path).replace(/\.md$/i, '');
  const icon = icons.get(path) ?? (folderPage ? icons.get(parentOf(path)) : undefined);
  return (
    <nav aria-label={t('page.breadcrumb')} className={styles.breadcrumb}>
      <ol>
        <li>
          <button type="button" onClick={() => reveal('')}>
            <ItemIcon icon={vaultIcon} />
            {vault}
          </button>
        </li>
        {/* Names a narrow band shortens show whole on hover (final review M9). */}
        {folders.map((folder) => (
          <li key={folder}>
            <button type="button" title={nameOf(folder)} onClick={() => reveal(folder)}>
              <ItemIcon icon={icons.get(folder)} />
              {nameOf(folder)}
            </button>
          </li>
        ))}
        <li>
          <span aria-current="page" title={page}>
            <ItemIcon icon={icon} />
            {page}
          </span>
        </li>
      </ol>
    </nav>
  );
}
