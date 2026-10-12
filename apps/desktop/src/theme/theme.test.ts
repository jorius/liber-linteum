import { describe, expect, it } from 'vitest';
import { applyTheme } from './theme';

describe('Q-UI-1 theme preference', () => {
  it('system removes the override so CSS follows the OS', () => {
    const root = document.createElement('html');
    root.dataset.theme = 'dark';
    applyTheme('system', root);
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it.each(['light', 'dark'] as const)('%s sets data-theme', (pref) => {
    const root = document.createElement('html');
    applyTheme(pref, root);
    expect(root.dataset.theme).toBe(pref);
  });

  it('defaults to document.documentElement', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    applyTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
