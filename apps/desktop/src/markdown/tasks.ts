/** A task list item's marker right at its start: `- [ ]`, `1. [x]`, … */
const TASK_AT = /^(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\]/;

/** The edit that toggles the task whose list item starts at `at` (a source
 *  offset from the model), or null when `at` is not the start of a task — a
 *  stale offset never edits text. */
export function toggleTask(
  text: string,
  at: number,
): { from: number; to: number; insert: string } | null {
  const m = TASK_AT.exec(text.slice(at, at + 32));
  if (!m) return null;
  const from = at + m[0].length - 2;
  return { from, to: from + 1, insert: m[1] === ' ' ? 'x' : ' ' };
}
