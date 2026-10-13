import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../stores/settingsStore';
import { applyAppearance, CUSTOM_STYLE_ID } from './appearance';

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

  it('a custom accent injects one generated stylesheet and updates it in place', () => {
    applyAppearance({ ...DEFAULT_SETTINGS, palette: 'custom', accentColor: '#2aa198' });
    expect(document.documentElement.dataset.palette).toBe('custom');
    const style = document.getElementById(CUSTOM_STYLE_ID)!;
    expect(style.textContent).toContain(":root[data-palette='custom'] {");
    expect(style.textContent).toContain('--color-accent:');
    const first = style.textContent;
    applyAppearance({ ...DEFAULT_SETTINGS, palette: 'custom', accentColor: '#6d28d9' });
    expect(document.querySelectorAll(`#${CUSTOM_STYLE_ID}`)).toHaveLength(1);
    expect(document.getElementById(CUSTOM_STYLE_ID)!.textContent).not.toBe(first);
    applyAppearance({ ...DEFAULT_SETTINGS, palette: 'sepia' });
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
