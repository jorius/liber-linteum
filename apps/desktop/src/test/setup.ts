import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import i18next from 'i18next';
import { afterEach, beforeAll, beforeEach } from 'vitest';
import { initI18n } from '../i18n';

beforeAll(async () => {
  await initI18n('en');
});

beforeEach(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => cleanup());
