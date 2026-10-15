import { useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  externalAssetUrl,
  externalNetworkAllow,
  externalReveal,
  type ExternalFile,
} from '../../ipc';
import { diskPathOf, networkServer, onWindows } from '../../markdown/externalPath';
import { followLink } from '../../stores/links';
import { errorMessage } from '../../stores/messages';
import { useOutsideStore } from '../../stores/outsideStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { useVaultStore } from '../../stores/vaultStore';
import { copyWithFeedback } from '../editor/widgets';
import styles from './Preview.module.css';

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const AUDIO = /\.(wav|mp3|m4a|ogg|flac)$/i;

const nameOf = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** "Show in Finder" / "Show in Explorer" / "Show in folder". */
function revealLabel(t: (key: string) => string): string {
  if (onWindows()) return t('preview.external.revealWindows');
  if (/Macintosh|Mac OS/i.test(navigator.userAgent)) return t('preview.external.revealMac');
  return t('preview.external.revealOther');
}

/** Where an attachment is on disk, selectable, with Copy path (M4b part 3
 *  §8). Rendered only while "Show where attachments are on disk" is on. */
function DiskPath({ path }: { path: string }) {
  const { t } = useTranslation();
  const label = useRef<HTMLSpanElement>(null);
  return (
    <span className={styles.diskPath} role="note" aria-label={t('preview.external.location')}>
      <code className={styles.diskPathText}>{path}</code>
      <button
        type="button"
        className={styles.codeCopy}
        aria-label={t('preview.external.copyPath')}
        onClick={() => label.current && copyWithFeedback(path, label.current)}
      >
        <span ref={label}>{t('preview.external.copyPath')}</span>
      </button>
    </span>
  );
}

/** `children`, then — with the setting on — where the file is on disk: a vault
 *  file (`vaultPath`) under the vault's folder, or an outside file's own path. */
export function WithDiskPath({
  vaultPath = null,
  diskPath = null,
  children,
}: {
  vaultPath?: string | null;
  diskPath?: string | null;
  children: ReactNode;
}) {
  const show = useSettingsStore((s) => s.settings.showAttachmentPaths === true);
  const root = useVaultStore((s) => s.info?.root ?? null);
  const path =
    diskPath ??
    (vaultPath !== null && root !== null ? diskPathOf(root, vaultPath, onWindows()) : null);
  return (
    <>
      {children}
      {show && path !== null && <DiskPath path={path} />}
    </>
  );
}

/** A file on another computer nobody has loaded yet (final review C1): its
 *  path and a button; nothing connects anywhere until it is pressed. */
function NetworkCard({ path }: { path: string }) {
  const { t } = useTranslation();
  const load = async () => {
    const res = await externalNetworkAllow(path);
    if (!res.ok) {
      useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
      return;
    }
    useOutsideStore.getState().loaded();
  };
  return (
    <span className={`${styles.card} ${styles.networkCard}`} title={path}>
      <span>{t('preview.external.network', { path })}</span>
      <span className={styles.cardNote}>
        {t('preview.external.networkNote', { server: networkServer(path) })}
      </span>
      <button type="button" className={styles.cardButton} onClick={() => void load()}>
        {t('preview.external.loadNetwork')}
      </button>
    </span>
  );
}

/** An embed or image naming a file outside the vault (M4b part 3 §9), as
 *  `links_external` describes it: shown once a saved page links it
 *  ("Loading…" until then), a "Network file" card until the user loads one
 *  on another computer, "Not found" with its path when it isn't there, else
 *  a file card with Open (after asking) and Show in Finder/Explorer. */
export function ExternalEmbed({
  file,
  alt,
  width,
  height,
}: {
  file: ExternalFile;
  alt: string;
  width?: number;
  height?: number;
}) {
  const { t } = useTranslation();
  if (!file.listed) return <span className={styles.pending}>{t('preview.loading')}</span>;
  if (file.askFirst) return <NetworkCard path={file.path} />;
  if (!file.exists) {
    return (
      <span className={styles.card}>{t('preview.external.notFound', { path: file.path })}</span>
    );
  }
  let body: ReactNode;
  if (IMAGE.test(file.path)) {
    body = (
      <img
        className={styles.embedImage}
        src={externalAssetUrl(file.path)}
        alt={alt}
        width={width}
        height={height}
        loading="lazy"
      />
    );
  } else if (AUDIO.test(file.path)) {
    body = (
      <audio
        className={styles.embedAudio}
        controls
        src={externalAssetUrl(file.path)}
        aria-label={nameOf(file.path)}
      />
    );
  } else {
    const reveal = async () => {
      const res = await externalReveal(file.path);
      if (!res.ok)
        useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
    };
    body = (
      <span className={styles.card} title={file.path}>
        <span className={styles.fileName}>{nameOf(file.path)}</span>
        {file.openable ? (
          <button
            type="button"
            className={styles.cardButton}
            onClick={() => followLink({ type: 'externalFile', path: file.path })}
          >
            {t('preview.external.open')}
          </button>
        ) : (
          <span className={styles.cardNote}>{t('preview.external.notOpenable')}</span>
        )}
        <button type="button" className={styles.cardButton} onClick={() => void reveal()}>
          {revealLabel(t)}
        </button>
      </span>
    );
  }
  return <WithDiskPath diskPath={file.path}>{body}</WithDiskPath>;
}
