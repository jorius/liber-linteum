import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../stores/settingsStore';
import { applyAppearance, CUSTOM_STYLE_ID } from './appearance';
import { newTheme, setColor } from './customThemes';
import { PALETTES } from './palettes';

afterEach(() => {
  document.documentElement.removeAttribute('data-palette');
  document.documentElement.removeAttribute('style');
  document.getElementById(CUSTOM_STYLE_ID)?.remove();
});

describe('applyAppearance (M2b §4)', () => {
  it('a built-in palette is one attribute on <html>; nothing else is injected', () => {
    applyAppearance({ ...DEFAULT_SETTINGS, palette: 'midnight' });
    expect(document.documentElement.dataset.palette).toBe('midnight');
    expect(document.getElementById(CUSTOM_STYLE_ID)).toBeNull();
  });

  it('applies_selected_custom_theme: one generated stylesheet, updated in place', () => {
    const a = newTheme(PALETTES[0], 'A', 'a');
    const b = setColor(newTheme(PALETTES[0], 'B', 'b'), 'light', 'accent', '#0e7c7b');
    const s = { ...DEFAULT_SETTINGS, palette: 'custom' as const, customThemes: [a, b] };
    applyAppearance({ ...s, customTheme: 'b' });
    expect(document.documentElement.dataset.palette).toBe('custom');
    const style = document.getElementById(CUSTOM_STYLE_ID)!;
    expect(style.textContent).toContain(":root[data-palette='custom'] {");
    expect(style.textContent).toContain('--color-accent: #0e7c7b;');
    applyAppearance({ ...s, customTheme: 'a' });
    expect(document.querySelectorAll(`#${CUSTOM_STYLE_ID}`)).toHaveLength(1);
    expect(document.getElementById(CUSTOM_STYLE_ID)!.textContent).not.toContain('#0e7c7b');
    applyAppearance({ ...DEFAULT_SETTINGS, palette: 'sepia' });
    expect(document.getElementById(CUSTOM_STYLE_ID)).toBeNull();
  });

  it('deleting_the_selected_theme_falls_back to Lavender (custom themes plan, focus 2)', () => {
    applyAppearance({
      ...DEFAULT_SETTINGS,
      palette: 'custom',
      customThemes: [],
      customTheme: 'gone',
    });
    expect(document.documentElement.dataset.palette).toBe('lavender');
    expect(document.getElementById(CUSTOM_STYLE_ID)).toBeNull();
  });

  it('M2b §5: fonts and text size become CSS variables on <html>', () => {
    applyAppearance({
      ...DEFAULT_SETTINGS,
      fontLivePreview: 'literata',
      fontSource: 'system:Menlo',
      fontSize: 18,
    });
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--font-live')).toBe("'Literata', Georgia, serif");
    expect(style.getPropertyValue('--font-source')).toContain('"Menlo"');
    expect(style.getPropertyValue('--font-size-editor')).toBe('18px');
  });
});
