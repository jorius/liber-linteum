import i18next from 'i18next';
import { externalReveal, type ExternalFile, type LinkKind } from '../ipc';
import { openPage } from './navigate';
import { isTextPath } from './textFiles';
import { usePageStore } from './pageStore';
import { useToastStore } from './toastStore';
import { useUiStore } from './uiStore';

/** What a click on a link or embed card leads to (M2a §3.4). */
export type LinkAction =
  | {
      type: 'page';
      kind: LinkKind;
      /** As written in the source (wiki target or vault path). */
      target: string;
      heading: string | null;
      /** Vault path the target resolves to; `null` = doesn't exist. */
      resolved: string | null;
      /** Page the link is on. */
      source: string;
    }
  | { type: 'external'; url: string }
  | { type: 'anchor'; heading: string }
  | { type: 'file'; path: string }
  /** A file outside the vault, by its absolute path (M4b part 3 §9);
   *  `network`: on another computer, not loaded yet (final review C1). */
  | { type: 'externalFile'; path: string; network?: boolean };

const isPage = (path: string) => /\.md$/i.test(path);

export function followLink(action: LinkAction): void {
  const ui = useUiStore.getState();
  switch (action.type) {
    case 'external':
      ui.openDialog({ type: 'openExternal', url: action.url });
      return;
    case 'file':
      // Text and code files open in the app (M4b part 2 §6).
      if (isTextPath(action.path)) void openPage(action.path, null, 'link');
      else ui.openDialog({ type: 'openFile', path: action.path });
      return;
    case 'anchor':
      usePageStore.getState().reveal(action.heading);
      return;
    case 'externalFile':
      ui.openDialog({
        type: 'openFile',
        path: action.path,
        external: true,
        ...(action.network ? { network: true } : {}),
      });
      return;
    case 'page':
      if (action.resolved === null) {
        ui.openDialog({ type: 'createPage', source: action.source, target: action.target });
      } else if (isPage(action.resolved)) {
        void openPage(action.resolved, action.heading, 'link');
      } else if (isTextPath(action.resolved)) {
        void openPage(action.resolved, null, 'link');
      } else {
        ui.openDialog({ type: 'openFile', path: action.resolved });
      }
  }
}

/** A click on a link naming a file outside the vault (M4b part 3 §9): it
 *  opens after asking — a network file is loaded only once the user agrees
 *  (final review C1), anything but a document or media is shown in its
 *  folder instead (I2) — or says where it was looked for. */
export function followOutside(file: ExternalFile): void {
  if (file.exists && !file.openable) {
    void externalReveal(file.path);
    useToastStore.getState().push({
      message: i18next.t('preview.external.revealedInstead', {
        name: file.path.split(/[\\/]/).pop() ?? file.path,
      }),
    });
  } else if (file.askFirst) followLink({ type: 'externalFile', path: file.path, network: true });
  else if (file.exists) followLink({ type: 'externalFile', path: file.path });
  else {
    useToastStore.getState().push({
      message: i18next.t('preview.external.notFound', { path: file.path }),
      tone: 'error',
    });
  }
}
