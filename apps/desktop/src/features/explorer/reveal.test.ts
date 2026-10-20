import { describe, expect, it } from 'vitest';
import { revealKey } from './reveal';

describe('the reveal item takes the platform’s own name (round 3 §9.4)', () => {
  it('Finder on macOS, File Explorer on Windows, a file manager elsewhere', () => {
    expect(revealKey('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('menu.revealMac');
    expect(revealKey('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('menu.revealWindows');
    expect(revealKey('Mozilla/5.0 (X11; Linux x86_64)')).toBe('menu.revealOther');
  });
});
