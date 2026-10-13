import { useTranslation } from 'react-i18next';
import { entryCreatePage, fileOpenExternal, urlOpen, type IpcResult } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { openPage } from '../../stores/navigate';
import { useToastStore } from '../../stores/toastStore';
import { nameOf, parentOf } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';
import { Dialog } from './Dialog';
import styles from './Dialogs.module.css';

function report(res: IpcResult<unknown>) {
  if (!res.ok) useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
}

function Confirm({
  title,
  text,
  confirm,
  onConfirm,
  onClose,
}: {
  title: string;
  text?: string;
  confirm: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog title={title} onClose={onClose}>
      {text && <p className={`${styles.text} ${styles.wrap}`}>{text}</p>}
      <div className={styles.buttons}>
        <button type="button" className={styles.button} onClick={onClose}>
          {t('dialogs.cancel')}
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
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

/** "Create page 'X'?" for an unresolved link: created next to the linking page. */
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
  const name = nameOf(target).replace(/\.md$/i, '');
  const dir = parentOf(source);
  const folder = dir || (useVaultStore.getState().info?.name ?? '');
  return (
    <Confirm
      title={t('dialogs.createPage.title', { name })}
      text={t('dialogs.createPage.where', { folder })}
      confirm={t('dialogs.createPage.confirm')}
      onConfirm={async () => {
        const res = await entryCreatePage(dir, name);
        report(res);
        if (!res.ok) return;
        await useVaultStore.getState().refreshTree();
        await openPage(res.value);
      }}
      onClose={onClose}
    />
  );
}
