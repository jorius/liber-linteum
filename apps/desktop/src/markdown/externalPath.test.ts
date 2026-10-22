import { afterEach, describe, expect, it, vi } from 'vitest';
import { externalAssetUrl } from '../ipc';
import { diskPathOf, isFileTarget, looksExternal } from './externalPath';

afterEach(() => vi.unstubAllGlobals());

describe('targets outside the vault (M4b part 3 §9)', () => {
  it('drive letters, UNC paths and file: URLs name files on disk', () => {
    for (const t of ['D:\\Docs\\x.pdf', 'd:/Docs/x.pdf', '\\\\server\\share\\x', 'FILE:///x.png']) {
      expect(isFileTarget(t)).toBe(true);
    }
    for (const t of ['https://e.com', 'Docs/x.pdf', '/Docs/x.pdf', 'D:x.pdf', 'mailto:a@b.c']) {
      expect(isFileTarget(t)).toBe(false);
    }
  });

  it('wiki targets may be outside with a path form; bare names never are', () => {
    for (const t of ['D:\\x.pdf', 'file:///x.pdf', '/Users/j/x.png', './x.png', '../x.png']) {
      expect(looksExternal(t)).toBe(true);
    }
    for (const t of ['x.png', 'Notes/x', 'Ideas']) expect(looksExternal(t)).toBe(false);
  });

  it('shows a vault file where it is on disk, with the OS separators', () => {
    expect(diskPathOf('/Users/j/Vault', 'Assets/x.png', false)).toBe('/Users/j/Vault/Assets/x.png');
    expect(diskPathOf('D:\\Notes_PC', 'Assets/Com/x.png', true)).toBe(
      'D:\\Notes_PC\\Assets\\Com\\x.png',
    );
    expect(diskPathOf('D:\\', 'x.png', true)).toBe('D:\\x.png');
  });

  it('outside files are asked for as one encoded segment after /.external/', () => {
    expect(externalAssetUrl('/Users/j/a b#1.png')).toBe(
      'liber-asset://localhost/.external/%2FUsers%2Fj%2Fa%20b%231.png',
    );
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    expect(externalAssetUrl('D:\\Pics\\a.png')).toBe(
      'http://liber-asset.localhost/.external/D%3A%5CPics%5Ca.png',
    );
  });
});
