import { describe, expect, it } from 'vitest';
import { toggleTask } from './tasks';

describe('toggleTask (feedback: click to toggle)', () => {
  it('checks and unchecks the task whose list item starts at the offset', () => {
    expect(toggleTask('- [ ] a\n', 0)).toEqual({ from: 3, to: 4, insert: 'x' });
    expect(toggleTask('x\n\n1. [X] b\n', 3)).toEqual({ from: 7, to: 8, insert: ' ' });
    expect(toggleTask('> - [x] c\n', 2)).toEqual({ from: 5, to: 6, insert: ' ' });
  });

  it('is a no-op when the offset is not a task (stale offsets never edit text)', () => {
    expect(toggleTask('- plain\n', 0)).toBeNull();
    expect(toggleTask('- [ ] a\n', 1)).toBeNull();
    expect(toggleTask('', 4)).toBeNull();
  });
});
