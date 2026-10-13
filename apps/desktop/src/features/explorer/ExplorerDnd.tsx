import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import { useState } from 'react';
import { dropEntry, planDrop, ROOT_DROP_ID } from './drop';
import { ExplorerTree, type ExplorerTreeProps } from './ExplorerTree';
import styles from './Explorer.module.css';

const targetOf = (id: string | number | undefined) =>
  id === undefined ? null : id === ROOT_DROP_ID ? '' : String(id);

/** Drag-and-drop moves in the explorer (pointer and keyboard sensors). Keyboard
 * drag: Space to pick up, arrows to move, Space to drop, Escape to cancel. */
export function ExplorerDnd(props: ExplorerTreeProps) {
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  );
  const root = useDroppable({ id: ROOT_DROP_ID });

  const onDragOver = ({ active, over: o }: DragOverEvent) => {
    const target = targetOf(o?.id);
    setOver(target !== null && planDrop(String(active.id), target) ? target : null);
  };
  const onDragEnd = ({ active, over: o }: DragEndEvent) => {
    setDragging(false);
    setOver(null);
    const target = targetOf(o?.id);
    if (target !== null) void dropEntry(String(active.id), target);
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={() => setDragging(true)}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setDragging(false);
        setOver(null);
      }}
    >
      <div
        ref={root.setNodeRef}
        className={over === '' ? `${styles.rootDrop} ${styles.drop}` : styles.rootDrop}
      >
        <ExplorerTree {...props} dragging={dragging} dropTarget={over} />
      </div>
    </DndContext>
  );
}
