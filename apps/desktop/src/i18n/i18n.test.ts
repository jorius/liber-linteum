import { describe, expect, it } from 'vitest';
import { detectLanguage, initI18n, SUPPORTED_LANGUAGES } from './index';

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
});
