// Test-only helpers. Tests outside src/ipc/ import Tauri's event/mock helpers
// from here, so the "backend only through src/ipc/" lint rule stays strict.
export { emit } from '@tauri-apps/api/event';
export { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
