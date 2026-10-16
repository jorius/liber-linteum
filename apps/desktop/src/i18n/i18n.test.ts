import { describe, expect, it } from 'vitest';
import { detectLanguage, initI18n, SUPPORTED_LANGUAGES } from './index';
import en from './locales/en.json';
import es from './locales/es.json';

/** Every string of a locale file, by key. */
function strings(value: unknown, key = ''): [string, string][] {
  if (typeof value === 'string') return [[key, value]];
  return Object.entries(value as object).flatMap(([k, v]) => strings(v, key ? `${key}.${k}` : k));
}

describe('Q-I18N-1 detectLanguage', () => {
  it.each([
    [['es-MX'], 'es'],
    [['es_ES'], 'es'],
    [['ES'], 'es'],
    [['es-419'], 'es'],
    [['fr-FR', 'es-ES'], 'es'],
    [['en-US', 'es'], 'en'],
    [['fr-FR'], 'en'],
    [[], 'en'],
    [['   '], 'en'],
  ])('%j → %s', (preferred, expected) => {
    expect(detectLanguage(preferred)).toBe(expected);
  });

  it('NFR-07 registry lists en and es', () => {
    expect(SUPPORTED_LANGUAGES).toEqual(['en', 'es']);
  });
});

describe('initI18n', () => {
  it('uses ICU interpolation', async () => {
    const i18n = await initI18n('en');
    expect(i18n.t('app.version', { version: '0.1.0' })).toBe('v0.1.0');
    await i18n.changeLanguage('es');
    expect(i18n.t('welcome.create')).toBe('Crear una bóveda nueva');
  });

  // M5b round 2: `{{save}}` showed as is in Settings. Messages are ICU, whose
  // placeholders take one brace; `{{…}}` is i18next's own syntax and never fills.
  it('no message uses double-brace placeholders', () => {
    const bad = [...strings(en), ...strings(es)].filter(([, v]) => v.includes('{{'));
    expect(bad).toEqual([]);
  });

  it('the Auto save hint names the shortcut', async () => {
    const i18n = await initI18n('en');
    expect(i18n.t('settings.autoSaveHint', { save: '⌘S' })).toMatch(/^When off, ⌘S saves\./);
  });

  it('NFR-10 keeps <html lang> in sync with the UI language', async () => {
    const i18n = await initI18n('es');
    expect(document.documentElement.lang).toBe('es');
    await i18n.changeLanguage('en');
    expect(document.documentElement.lang).toBe('en');
    await i18n.changeLanguage('es');
    expect(document.documentElement.lang).toBe('es');
  });
});
