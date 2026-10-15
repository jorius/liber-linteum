import type { LinkKind } from '../ipc';
import { openPage } from './navigate';
import { isTextPath } from './textFiles';
import { usePageStore } from './pageStore';
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
  | { type: 'file'; path: string };

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
