import i18next from 'i18next';
import ICU from 'i18next-icu';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import es from './locales/es.json';

// NFR-07: adding a language = add locales/<code>.json and one entry here.
const LOCALES = { en, es } as const;

export type Language = keyof typeof LOCALES;
export const SUPPORTED_LANGUAGES = Object.keys(LOCALES) as Language[];

// Q-I18N-1: first supported base language in the OS preference list, else English.
export function detectLanguage(preferred: readonly string[]): Language {
  for (const tag of preferred) {
    const base = tag.trim().toLowerCase().split(/[-_]/)[0];
    const match = SUPPORTED_LANGUAGES.find((lng) => lng === base);
    if (match) return match;
  }
  return 'en';
}

// NFR-10: assistive tech and hyphenation need <html lang> to match the UI language.
function syncDocumentLang(language: string) {
  if (typeof document !== 'undefined') document.documentElement.lang = language;
}

export async function initI18n(language: Language) {
  const resources = Object.fromEntries(
    Object.entries(LOCALES).map(([lng, translation]) => [lng, { translation }]),
  );
  await i18next
    .use(ICU)
    .use(initReactI18next)
    .init({ resources, lng: language, fallbackLng: 'en', interpolation: { escapeValue: false } });
  syncDocumentLang(i18next.language);
  i18next.off('languageChanged', syncDocumentLang);
  i18next.on('languageChanged', syncDocumentLang);
  return i18next;
}
