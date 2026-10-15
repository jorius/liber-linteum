import i18next from 'i18next';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FormatIcon, GearIcon, OutlineIcon } from '../../app/icons';
import { destroyWindow, pageCreateConflictCopy, type FileInfo, type Page } from '../../ipc';
import { confirmedBlock, data } from '../../markdown/frontmatterEdit';
import { useEditorStore } from '../../stores/editorStore';
import { errorMessage } from '../../stores/messages';
import { useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { DialogHost } from '../dialogs/DialogHost';
import { Editor } from '../editor/Editor';
import { ModeToggle } from '../page/ModeToggle';
import { PageSubtitle } from '../page/PageSubtitle';
import { PageTitle } from '../page/PageTitle';
import { TextStats } from '../page/TextView';
import { WidthMenu } from '../page/WidthMenu';
import { WordCount } from '../page/WordCount';
import page from '../page/PageView.module.css';
import shell from '../shell/Shell.module.css';
import { Toaster } from '../toasts/Toaster';
import styles from './SingleFile.module.css';
import { useSingleFileStore } from './singleFileStore';

/** What `PageSubtitle` needs of a page: its subtitle, from the text. */
const pageWith = (path: string, subtitle: string | null): Page => ({
  path,
  title: path,
  subtitle,
  cover: null,
  coverY: null,
  coverX: null,
  tags: [],
  links: 0,
  backlinks: 0,
  text: '',
  truncated: false,
  binary: false,
});

/** The file's name (renamable on disk) and, for Markdown, its subtitle;
 *  then Settings. No vault, Global View or sidebar (M4c §3). */
function FileTopBar({ info }: { info: FileInfo }) {
  const { t } = useTranslation();
  const doc = useEditorStore((s) => s.doc);
  // The subtitle is read again after each save (frontmatter edits save at once).
  const hash = useEditorStore((s) => s.hash);
  const subtitle = useMemo(() => {
    const block = doc ? confirmedBlock(doc.text) : null;
    const value = block ? data(block.src)?.subtitle : null;
    return typeof value === 'string' ? value : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, hash]);
  return (
    <header className={shell.topbar}>
      <div className={shell.heading}>
        <PageTitle path={info.name} rename={(to) => useSingleFileStore.getState().rename(to)} />
        {info.kind === 'page' && doc && (
          <PageSubtitle page={pageWith(info.name, subtitle)} editable />
        )}
      </div>
      <div />
      <div className={shell.tright}>
        <button
          type="button"
          className={shell.iconButtonLight}
          aria-label={t('shell.settings')}
          title={t('shell.settings')}
          onClick={() => useUiStore.getState().openDialog({ type: 'settings' })}
        >
          <GearIcon />
        </button>
      </div>
    </header>
  );
}

/** The file lies in a recent vault: open it there instead. */
function OpenInVaultBar({ info }: { info: FileInfo }) {
  const { t } = useTranslation();
  if (!info.vault) return null;
  return (
    <div className={styles.vaultBar} role="region" aria-label={t('singleFile.inVaultRegion')}>
      <p>{t('singleFile.inVault', { name: info.vault.name })}</p>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => void useSingleFileStore.getState().openInVault()}
      >
        {t('singleFile.openInVault')}
      </button>
    </div>
  );
}

/** Text the file can't take any more (rewritten outside as something the
 *  app can't edit): kept, and saved as a copy next to it on request. */
async function saveCopy(): Promise<void> {
  const editor = useEditorStore.getState();
  if (!editor.path) return;
  const text = editor.liveText(editor.path) ?? '';
  const res = await pageCreateConflictCopy(editor.path, text);
  useToastStore
    .getState()
    .push(
      res.ok
        ? { message: i18next.t('singleFile.copySaved', { name: res.value }) }
        : { message: errorMessage(res.error), tone: 'error' },
    );
}

/** Why the text can't be saved, or that the file is gone, with what to do. */
function FileNotices({ text }: { text: boolean }) {
  const { t } = useTranslation();
  const orphaned = useEditorStore((s) => s.orphaned && s.doc !== null);
  const why = useEditorStore((s) => (s.dirty ? s.unwritable : null));
  const gone = useSingleFileStore((s) => s.gone);
  if (gone) {
    return (
      <div className={page.orphan}>
        <p className={page.notice}>{t('singleFile.gone')}</p>
        <button type="button" className="btn btn-secondary" onClick={() => void destroyWindow()}>
          {t('singleFile.closeWindow')}
        </button>
      </div>
    );
  }
  if (orphaned) {
    return (
      <div className={page.orphan}>
        <p className={page.notice}>{t('singleFile.deleted')}</p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void useEditorStore.getState().saveAsNew()}
        >
          {t('singleFile.saveAgain')}
        </button>
      </div>
    );
  }
  if (!why) return null;
  return (
    <div className={page.orphan}>
      <p className={page.notice}>
        {why === 'text' ? t('editor.tooLarge') : t(text ? 'editor.notText' : 'editor.notTextPage')}
      </p>
      {why === 'disk' && (
        <button type="button" className="btn btn-primary" onClick={() => void saveCopy()}>
          {t('singleFile.saveCopy')}
        </button>
      )}
    </div>
  );
}

/** The compact header band (Saved, the count, Format, width, outline, the
 *  mode switch) and the editor — the text view's for text and code. */
function FileView({ info }: { info: FileInfo }) {
  const { t } = useTranslation();
  const doc = useEditorStore((s) => s.doc);
  const error = useEditorStore((s) => s.error);
  const status = useEditorStore((s) => s.status);
  const mode = useSettingsStore((s) => s.settings.editorMode);
  const toolbar = useSettingsStore((s) => s.settings.toolbar);
  const outline = useSettingsStore((s) => s.settings.outline);
  const text = info.kind === 'text';
  return (
    <main className={shell.content}>
      <section className={page.page} aria-label={t('page.region')}>
        <div data-band="plain" className={page.band}>
          <div className={page.bandRows}>
            <div className={page.bar}>
              <div className={`${page.where} ${page.pill}`}>
                <span className={styles.folder} title={info.folder}>
                  {info.folder}
                </span>
              </div>
              {doc && (
                <div className={page.controls}>
                  <span
                    role="status"
                    aria-label={t('editor.saveStatus')}
                    className={`${page.status} ${page.pill}`}
                  >
                    {t(`editor.${status}`)}
                  </span>
                  {text ? <TextStats /> : <WordCount />}
                  {!text && (
                    <button
                      type="button"
                      className={page.toolbarToggle}
                      aria-pressed={toolbar}
                      aria-label={t('toolbar.toggle')}
                      title={t(toolbar ? 'toolbar.hide' : 'toolbar.show')}
                      onClick={() => void useSettingsStore.getState().update({ toolbar: !toolbar })}
                    >
                      <FormatIcon />
                      <span aria-hidden="true">{t('toolbar.short')}</span>
                    </button>
                  )}
                  {!text && <WidthMenu path={info.name} />}
                  {!text && (
                    <button
                      type="button"
                      className={page.toolbarToggle}
                      aria-pressed={outline}
                      aria-label={t('outline.toggle')}
                      title={t(outline ? 'outline.hide' : 'outline.show')}
                      onClick={() => void useSettingsStore.getState().update({ outline: !outline })}
                    >
                      <OutlineIcon />
                    </button>
                  )}
                  {!text && <ModeToggle mode={mode} />}
                </div>
              )}
            </div>
          </div>
        </div>
        <FileNotices text={text} />
        {error && !doc ? (
          <p className={`${page.notice} ${page.inset}`}>
            {error.kind === 'notAText' || error.kind === 'binary'
              ? t('singleFile.notText')
              : errorMessage(error)}
          </p>
        ) : (
          doc && <Editor doc={doc} mode={text ? 'source' : mode} label={info.name} />
        )}
      </section>
    </main>
  );
}

/** A window showing one file opened on its own (M4c §3). */
export function SingleFileApp() {
  const { t } = useTranslation();
  const info = useSingleFileStore((s) => s.info);
  const error = useSingleFileStore((s) => s.error);
  useEffect(() => {
    void useSingleFileStore.getState().load();
  }, []);
  return (
    <div className={styles.window}>
      {info ? (
        <>
          <FileTopBar info={info} />
          <OpenInVaultBar info={info} />
          <FileView info={info} />
        </>
      ) : (
        <main className={page.center}>
          <p className={page.muted} role={error ? 'alert' : 'status'}>
            {error ? errorMessage(error) : t('page.loading')}
          </p>
        </main>
      )}
      <DialogHost />
      <Toaster />
    </div>
  );
}
