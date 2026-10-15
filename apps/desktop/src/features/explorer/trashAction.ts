import { requestDelete } from './deleteFlow';

/** Every way to trash an item from the explorer — the row's 🗑, its menu,
 *  Delete and ⌘⌫ (M5b §3) — goes through here, so the Trash (§5) has one
 *  place to take it over. Today: the delete confirmation, then the trash. */
export function requestTrash(path: string) {
  requestDelete(path);
}
