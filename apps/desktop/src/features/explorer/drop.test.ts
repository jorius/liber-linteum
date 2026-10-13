import { describe, expect, it } from 'vitest';
import { planDrop } from './drop';

describe('planDrop (EXP-02 drag-and-drop rules)', () => {
  it('moves into another folder or the root, keeping the name', () => {
    expect(planDrop('Art/rex.md', 'Games')).toBe('Games/rex.md');
    expect(planDrop('Art/rex.md', '')).toBe('rex.md');
    expect(planDrop('Art/DMC', 'Games')).toBe('Games/DMC');
  });

  it('refuses drops onto itself, its current folder or its own descendant', () => {
    expect(planDrop('Art/rex.md', 'Art')).toBeNull();
    expect(planDrop('rex.md', '')).toBeNull();
    expect(planDrop('Art', 'Art')).toBeNull();
    expect(planDrop('Art', 'Art/DMC')).toBeNull();
    expect(planDrop('Art', 'Art/DMC/Deep')).toBeNull();
  });

  it('does not confuse sibling prefixes with descendants', () => {
    expect(planDrop('Art', 'Artwork')).toBe('Artwork/Art');
  });
});
