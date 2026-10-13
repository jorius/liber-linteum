import { describe, expect, it } from 'vitest';
import { fontStack, LIVE_FONTS, SOURCE_FONTS, systemChoice } from './fonts';

describe('fonts (M2b §5)', () => {
  it('bundled ids map to their stacks with a fallback', () => {
    expect(fontStack('atkinson-hyperlegible', 'live')).toBe(
      "'Atkinson Hyperlegible', system-ui, sans-serif",
    );
    expect(fontStack('literata', 'live')).toBe("'Literata', Georgia, serif");
    expect(fontStack('jetbrains-mono', 'source')).toBe(
      "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
    );
  });

  it('an installed family is used by name, quoted and escaped, before the default stack', () => {
    expect(fontStack(systemChoice('Avenir Next'), 'live')).toBe(
      '"Avenir Next", \'Atkinson Hyperlegible\', system-ui, sans-serif',
    );
    expect(fontStack('system:Odd "Name" \\ X', 'source')).toBe(
      '"Odd \\"Name\\" \\\\ X", \'JetBrains Mono\', ui-monospace, Menlo, Consolas, monospace',
    );
  });

  it('an unknown choice falls back to the default for that kind', () => {
    expect(fontStack('comic-sans', 'live')).toBe(fontStack('atkinson-hyperlegible', 'live'));
    expect(fontStack('system:', 'source')).toBe(fontStack('jetbrains-mono', 'source'));
  });

  it('the bundled lists match the ids the Rust settings accept (settings.rs BUNDLED_FONTS)', () => {
    expect([...LIVE_FONTS, ...SOURCE_FONTS].map((f) => f.id)).toEqual([
      'atkinson-hyperlegible',
      'literata',
      'source-serif-4',
      'ibm-plex-sans',
      'plus-jakarta-sans',
      'system-ui',
      'jetbrains-mono',
      'ibm-plex-mono',
      'source-code-pro',
      'system-mono',
    ]);
  });
});
