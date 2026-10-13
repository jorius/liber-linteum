import i18next from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROOT_DROP_ID } from './drop';
import { announcements, createSpringLoad, dropFeedback, SPRING_LOAD_MS } from './dragFeedback';

describe('dropFeedback (EXP-02 drag feedback)', () => {
  it('is "none" when not over any target', () => {
    expect(dropFeedback('Art/rex.md', null)).toBe('none');
  });
  it('is "allowed" over another folder or the root', () => {
    expect(dropFeedback('Art/rex.md', 'Games')).toBe('allowed');
    expect(dropFeedback('Art/rex.md', ROOT_DROP_ID)).toBe('allowed');
  });
  it('is "forbidden" over itself, its current folder or its own descendant', () => {
    expect(dropFeedback('Art', 'Art')).toBe('forbidden');
    expect(dropFeedback('Art/rex.md', 'Art')).toBe('forbidden');
    expect(dropFeedback('Art', 'Art/DMC')).toBe('forbidden');
    expect(dropFeedback('rex.md', ROOT_DROP_ID)).toBe('forbidden');
  });
});

describe('spring-loaded folders', () => {
  afterEach(() => vi.useRealTimers());

  it(`opens a hovered folder after ${SPRING_LOAD_MS} ms, once`, () => {
    vi.useFakeTimers();
    const open = vi.fn();
    const spring = createSpringLoad(open);
    spring.hover('Games');
    vi.advanceTimersByTime(SPRING_LOAD_MS - 1);
    expect(open).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(open).toHaveBeenCalledWith('Games');
    spring.hover('Games');
    vi.advanceTimersByTime(SPRING_LOAD_MS * 2);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('restarts when the target changes and stops when hovering nothing', () => {
    vi.useFakeTimers();
    const open = vi.fn();
    const spring = createSpringLoad(open);
    spring.hover('A');
    vi.advanceTimersByTime(SPRING_LOAD_MS - 100);
    spring.hover('B');
    vi.advanceTimersByTime(SPRING_LOAD_MS - 1);
    expect(open).not.toHaveBeenCalled();
    spring.hover(null);
    vi.advanceTimersByTime(SPRING_LOAD_MS * 2);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('keyboard-drag announcements (NFR-10)', () => {
  it('describe pick-up, hover, drop and cancel with display names', async () => {
    await i18next.changeLanguage('en');
    const a = announcements((p) =>
      p === '' ? 'Vault' : (p.split('/').pop() ?? p).replace(/\.md$/, ''),
    );
    expect(a.onDragStart({ active: { id: 'Art/rex.md' } } as never)).toBe('Picked up rex.');
    expect(a.onDragOver({ active: { id: 'Art/rex.md' }, over: { id: 'Games' } } as never)).toBe(
      'rex is over Games.',
    );
    expect(a.onDragOver({ active: { id: 'Art/rex.md' }, over: null } as never)).toBe(
      'rex is not over a folder.',
    );
    expect(a.onDragEnd({ active: { id: 'Art/rex.md' }, over: { id: ROOT_DROP_ID } } as never)).toBe(
      'Moved rex to Vault.',
    );
    expect(a.onDragCancel({ active: { id: 'Art/rex.md' } } as never)).toBe(
      'Move of rex cancelled.',
    );
  });
});
