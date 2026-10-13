import { afterEach, describe, expect, it, vi } from 'vitest';
import { assetUrl } from './index';

afterEach(() => vi.unstubAllGlobals());

describe('assetUrl (M2a §2.5: vault files through nimw-asset:)', () => {
  it('encodes each path segment for the custom protocol', () => {
    expect(assetUrl('Character Design/assets/rex #1.png')).toBe(
      'nimw-asset://localhost/Character%20Design/assets/rex%20%231.png',
    );
  });

  it('uses the http form on Windows (WebView2)', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    expect(assetUrl('a/b.png')).toBe('http://nimw-asset.localhost/a/b.png');
  });
});
