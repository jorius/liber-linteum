import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // WebView2 (Chromium) on Windows, WKWebView ≥ Safari 15 on macOS 12+, WebKitGTK on Linux.
    target: ['es2021', 'chrome105', 'safari15'],
    // Never inline assets as data: URIs (fonts must match CSP font-src 'self').
    assetsInlineLimit: 0,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  test: {
    environment: 'jsdom',
    css: true,
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
  },
});
