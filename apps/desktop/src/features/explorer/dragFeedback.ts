import type { Announcements } from '@dnd-kit/core';
import i18next from 'i18next';
import { planDrop, ROOT_DROP_ID } from './drop';

/** How long a collapsed folder must be hovered during a drag before it opens. */
export const SPRING_LOAD_MS = 700;

export type DropFeedback = 'none' | 'allowed' | 'forbidden';

const targetPath = (overId: string) => (overId === ROOT_DROP_ID ? '' : overId);

/** Visual state of a drag: not over a target, over an allowed target, or over
 * a target the item can't move to (itself, its folder, its own descendant). */
export function dropFeedback(activeId: string, overId: string | null): DropFeedback {
  if (overId === null) return 'none';
  return planDrop(activeId, targetPath(overId)) ? 'allowed' : 'forbidden';
}

/** Spring-loaded folders: hovering one target for SPRING_LOAD_MS calls `open`
 * once; changing target restarts the timer, hovering nothing cancels it. */
export function createSpringLoad(open: (path: string) => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: string | null = null;
  let opened: string | null = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    hover(path: string | null) {
      if (path === current) return;
      current = path;
      cancel();
      if (path === null || path === opened) return;
      timer = setTimeout(() => {
        timer = null;
        opened = path;
        open(path);
      }, SPRING_LOAD_MS);
    },
    cancel() {
      cancel();
      current = null;
      opened = null;
    },
  };
}

/** Screen-reader announcements for keyboard drags (dnd-kit `accessibility`). */
export function announcements(displayNameOf: (path: string) => string): Announcements {
  const name = (id: string | number) => displayNameOf(String(id));
  const target = (id: string | number) => displayNameOf(targetPath(String(id)));
  return {
    onDragStart: ({ active }) => i18next.t('explorer.drag.pickedUp', { name: name(active.id) }),
    onDragOver: ({ active, over }) =>
      over
        ? i18next.t('explorer.drag.over', { name: name(active.id), target: target(over.id) })
        : i18next.t('explorer.drag.notOver', { name: name(active.id) }),
    onDragEnd: ({ active, over }) => {
      if (!over) return i18next.t('explorer.drag.cancelled', { name: name(active.id) });
      return dropFeedback(String(active.id), String(over.id)) === 'allowed'
        ? i18next.t('explorer.drag.moved', { name: name(active.id), target: target(over.id) })
        : i18next.t('explorer.drag.notAllowed', { name: name(active.id) });
    },
    onDragCancel: ({ active }) => i18next.t('explorer.drag.cancelled', { name: name(active.id) }),
  };
}
