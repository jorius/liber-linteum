import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useEffect, useMemo, useState } from 'react';
import { nameOf } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';
import { announcements, createSpringLoad, dropFeedback, type DropFeedback } from './dragFeedback';
import { dropEntry, ROOT_DROP_ID } from './drop';
import { ExplorerTree, type ExplorerTreeProps } from './ExplorerTree';
import styles from './Explorer.module.css';
import { displayName, Icon } from './TreeRow';

const targetOf = (id: string | number | undefined) =>
  id === undefined ? null : id === ROOT_DROP_ID ? '' : String(id);

/** Drag-and-drop moves in the explorer (pointer and keyboard sensors). Keyboard
 * drag: Space to pick up, arrows to move, Space to drop, Escape to cancel.
 * Feedback: a ghost follows the pointer, the source row dims, an allowed target
 * is tinted and ringed, a forbidden one greys the ghost; hovering a collapsed
 * folder opens it after a moment (spring-loaded). */
export function ExplorerDnd(props: ExplorerTreeProps) {
  const [active, setActive] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<DropFeedback>('none');
  const nodes = useVaultStore((s) => s.nodes);
  const vaultName = useVaultStore((s) => s.info?.name ?? '');
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  );
  const root = useDroppable({ id: ROOT_DROP_ID });
  const spring = useMemo(
    () => createSpringLoad((path) => useVaultStore.getState().expand(path)),
    [],
  );

  const nodeOf = (path: string) => nodes.find((n) => n.path === path);
  const nameFor = (path: string) => {
    if (path === '') return vaultName;
    const node = nodeOf(path);
    return node ? displayName(node) : nameOf(path);
  };

  // The pointer cursor follows the drop state while dragging.
  useEffect(() => {
    if (!active) return;
    document.body.style.cursor = feedback === 'forbidden' ? 'not-allowed' : 'grabbing';
    return () => {
      document.body.style.cursor = '';
    };
  }, [active, feedback]);

  const reset = () => {
    spring.cancel();
    setActive(null);
    setOver(null);
    setFeedback('none');
  };

  const onDragStart = ({ active: a }: DragStartEvent) => setActive(String(a.id));
  const onDragOver = ({ active: a, over: o }: DragOverEvent) => {
    const overId = o ? String(o.id) : null;
    const state = dropFeedback(String(a.id), overId);
    setFeedback(state);
    setOver(state === 'allowed' ? targetOf(o?.id) : null);
    // Spring-loading opens folders only; a plain page has nothing to open.
    const folder =
      overId && overId !== ROOT_DROP_ID && nodeOf(overId)?.kind === 'folder' ? overId : null;
    spring.hover(folder && !useVaultStore.getState().expanded.has(folder) ? folder : null);
  };
  const onDragEnd = ({ active: a, over: o }: DragEndEvent) => {
    reset();
    const target = targetOf(o?.id);
    if (target !== null) void dropEntry(String(a.id), target);
  };

  const dragged = active ? nodeOf(active) : undefined;

  return (
    <DndContext
      sensors={sensors}
      accessibility={{ announcements: announcements(nameFor) }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={reset}
    >
      <div
        ref={root.setNodeRef}
        className={over === '' ? `${styles.rootDrop} ${styles.drop}` : styles.rootDrop}
      >
        <ExplorerTree {...props} dragging={active !== null} dropTarget={over} />
      </div>
      <DragOverlay dropAnimation={null}>
        {dragged ? (
          <div
            className={
              feedback === 'forbidden' ? `${styles.ghost} ${styles.ghostForbidden}` : styles.ghost
            }
          >
            <Icon node={dragged} expanded={false} />
            <span>{displayName(dragged)}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
