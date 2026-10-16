import i18next from 'i18next';
import {
  archiveRestore,
  entryArchive,
  trashDelete,
  trashEmpty,
  trashRestore,
  type BinItem,
  type IpcResult,
} from '../../ipc';
import { useEditorStore } from '../../stores/editorStore';
import { errorMessage } from '../../stores/messages';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { useBinStore } from './binStore';

const toast = () => useToastStore.getState();
const vault = () => useVaultStore.getState();

/** `clash`: something new is where it was (ask, then `keepBoth`). */
export type RestoreResult = 'done' | 'clash' | 'failed';

function failed(res: IpcResult<unknown>, kind: 'trash' | 'archive', path: string): RestoreResult {
  if (res.ok) return 'done';
  if (res.error.kind === 'alreadyExists') {
    useUiStore.getState().openDialog({ type: 'binClash', kind, path });
    return 'clash';
  }
  toast().push({ message: errorMessage(res.error), tone: 'error' });
  return 'failed';
}

/** Restores from the Trash, or unarchives (M5b §5.2, §5.3); a clash asks
 *  whether to keep both. */
export async function restoreItem(
  kind: 'trash' | 'archive',
  path: string,
  keepBoth = false,
): Promise<RestoreResult> {
  if (kind === 'trash') {
    const res = await trashRestore(path, keepBoth);
    if (res.ok) await vault().refreshTree();
    return failed(res, kind, path);
  }
  await useEditorStore.getState().flushBefore(path); // the move takes the latest text
  const res = await archiveRestore(path, keepBoth);
  if (res.ok) {
    const to = res.value.moved.find(([from]) => from === path)?.[1] ?? path;
    await vault().applyRename(path, to, res.value);
  }
  return failed(res, kind, path);
}

/** Deletes items from the Trash for good (to the system Trash). */
export async function deleteItems(items: BinItem[]) {
  const res = await trashDelete(items.map((i) => i.path));
  if (!res.ok) toast().push({ message: errorMessage(res.error), tone: 'error' });
  await useBinStore.getState().refresh();
}

export async function emptyTrash() {
  const res = await trashEmpty();
  if (!res.ok) toast().push({ message: errorMessage(res.error), tone: 'error' });
  await useBinStore.getState().refresh();
}

/** Archives a page or folder (M5b §5.3): it leaves the explorer, links keep
 *  working, and the toast can undo it. */
export async function archiveItem(path: string) {
  await useEditorStore.getState().flushBefore(path);
  const res = await entryArchive(path);
  if (!res.ok) {
    toast().push({ message: errorMessage(res.error), tone: 'error' });
    return;
  }
  const to = res.value.moved.find(([from]) => from === path)?.[1] ?? `.archive/${path}`;
  await vault().applyRename(path, to, res.value);
  toast().push({
    message: i18next.t('bin.archivedToast'),
    action: {
      label: i18next.t('bin.undo'),
      run: () => void restoreItem('archive', to),
    },
  });
}
