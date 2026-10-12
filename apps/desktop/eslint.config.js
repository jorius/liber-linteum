import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const NETWORK =
  'Notes In My Way makes no network requests (P1, NFR-04). Reach the backend through src/ipc/.';
const NETWORK_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'];
const GLOBAL_OBJECTS = ['window', 'globalThis', 'self'];

export default defineConfig(
  { ignores: ['dist/**', 'src-tauri/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-restricted-globals': [
        'error',
        ...NETWORK_GLOBALS.map((name) => ({ name, message: NETWORK })),
      ],
      'no-restricted-properties': [
        'error',
        ...GLOBAL_OBJECTS.flatMap((object) =>
          NETWORK_GLOBALS.map((property) => ({ object, property, message: NETWORK })),
        ),
        { object: 'navigator', property: 'sendBeacon', message: NETWORK },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@tauri-apps/api/core', message: 'Import backend calls from src/ipc/ only.' },
          ],
        },
      ],
    },
  },
  { files: ['src/ipc/**'], rules: { 'no-restricted-imports': 'off' } },
);
