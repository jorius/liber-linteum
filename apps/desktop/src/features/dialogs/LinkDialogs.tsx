import { useTranslation } from 'react-i18next';
import {
  entryCreateFolder,
  entryCreatePage,
  fileOpenExternal,
  urlOpen,
  type IpcResult,
} from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { openNewPage } from '../../stores/navigate';
import { useToastStore } from '../../stores/toastStore';
import { nameOf, parentOf } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';
import { validateName } from '../explorer/nameRules';
import { Dialog } from './Dialog';
import styles from './Dialogs.module.css';

function report(res: IpcResult<unknown>) {
  if (!res.ok) useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
}

function Confirm({
  title,
  text,
  error,
  confirm,
  onConfirm,
  onClose,
}: {
  title: string;
  text?: string;
  /** Shown as an alert; the confirm button is disabled. */
  error?: string | null;
  confirm: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog title={title} onClose={onClose}>
      {text && <p className={`${styles.text} ${styles.wrap}`}>{text}</p>}
      {error && (
        <p role="alert" className={`${styles.text} ${styles.wrap}`}>
          {error}
        </p>
      )}
      <div className={styles.buttons}>
        <button type="button" className={styles.button} onClick={onClose}>
          {t('dialogs.cancel')}
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          disabled={Boolean(error)}
          onClick={() => {
            onClose();
            void onConfirm();
          }}
        >
          {confirm}
        </button>
      </div>
    </Dialog>
  );
}

/** External links leave the app only after a confirmation, to the OS browser (P1). */
export function OpenExternalDialog({ url, onClose }: { url: string; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Confirm
      title={t('dialogs.external.title')}
      text={url}
      confirm={t('dialogs.external.confirm')}
      onConfirm={async () => report(await urlOpen(url))}
      onClose={onClose}
    />
  );
}

export function OpenFileDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Confirm
      title={t('dialogs.openFile.title', { name: nameOf(path) })}
      confirm={t('dialogs.openFile.confirm')}
      onConfirm={async () => report(await fileOpenExternal(path))}
      onClose={onClose}
    />
  );
}

/** Where "Create page" puts a link's target (M2c §7.6): a target with `/`
 *  (or a leading `/`) is a path from the vault root, with any missing folders
 *  (`missing`, outermost first); a bare name goes next to the linking page. */
export function createTarget(
  source: string,
  target: string,
  folders: Set<string>,
): { dir: string; name: string; missing: string[] } {
  const rooted = target.startsWith('/');
  const clean = target.replace(/^\/+/, '').replace(/\.md$/i, '');
  if (!rooted && !clean.includes('/')) return { dir: parentOf(source), name: clean, missing: [] };
  const parts = clean.split('/').filter(Boolean);
  const name = parts.pop() ?? '';
  const missing: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    if (!folders.has(dir)) missing.push(dir);
  }
  return { dir: parts.join('/'), name, missing };
}

/** "Create page 'X'?" for an unresolved link, creating missing folders first. */
export function CreatePageDialog({
  source,
  target,
  onClose,
}: {
  source: string;
  target: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const folders = new Set(
    useVaultStore
      .getState()
      .nodes.filter((n) => n.kind === 'folder')
      .map((n) => n.path),
  );
  const { dir, name, missing } = createTarget(source, target, folders);
  const folder = dir || (useVaultStore.getState().info?.name ?? '');
  // Only names this dialog will create are checked: folders that already exist
  // (made in Finder with "#", "[", ":" …) stay usable, as in M2a.
  const bad = [...missing.map(nameOf), name]
    .map((part) => ({ part, problem: validateName(part) }))
    .find((x) => x.problem);
  const error = bad
    ? t('dialogs.createPage.invalid', {
        name: bad.part,
        reason: t(
          `explorer.nameErrors.${bad.problem!.key}`,
          bad.problem!.key === 'forbidden' ? { char: bad.problem!.char } : {},
        ),
      })
    : null;
  // A path target names its folder in the title; a bare name keeps M2a's.
  const title =
    dir && target.includes('/')
      ? t('dialogs.createPage.titleIn', { name, folder: dir })
      : t('dialogs.createPage.title', { name });
  return (
    <Confirm
      title={title}
      text={t('dialogs.createPage.where', { folder })}
      error={error}
      confirm={t('dialogs.createPage.confirm')}
      onConfirm={async () => {
        for (const path of missing) {
          const res = await entryCreateFolder(parentOf(path), nameOf(path));
          if (!res.ok && res.error.kind !== 'alreadyExists') return report(res);
        }
        const res = await entryCreatePage(dir, name);
        report(res);
        if (!res.ok) return;
        await openNewPage(res.value, 'link');
      }}
      onClose={onClose}
    />
  );
}
