import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const NETWORK =
  'Notes In My Way makes no network requests (P1, NFR-04). Reach the backend through src/ipc/.';
const NETWORK_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'];
const GLOBAL_OBJECTS = ['window', 'globalThis', 'self'];

const BACKEND = 'Import backend calls from src/ipc/ only.';
// Backend access is confined to src/ipc/. `@tauri-apps/api/mocks` is the one
// exception, and only in test files (see the override below).
const backendImportRule = (allowMocksInTests) => [
  'error',
  {
    paths: [{ name: '@tauri-apps/api', message: BACKEND }],
    patterns: [
      {
        group: [
          '@tauri-apps/api/*',
          ...(allowMocksInTests ? ['!@tauri-apps/api/mocks'] : []),
          '@tauri-apps/plugin-*',
        ],
        message: BACKEND,
      },
    ],
  },
];

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
      // sendBeacon is caught on any object chain (window.navigator.sendBeacon, ...).
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[property.name='sendBeacon']", message: NETWORK },
        { selector: "MemberExpression[property.value='sendBeacon']", message: NETWORK },
      ],
      'no-restricted-imports': backendImportRule(false),
    },
  },
  { files: ['**/*.test.{ts,tsx}'], rules: { 'no-restricted-imports': backendImportRule(true) } },
  { files: ['src/ipc/**'], rules: { 'no-restricted-imports': 'off' } },
);
