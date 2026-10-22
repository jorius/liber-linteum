import './theme/tokens.css';
import './theme/palettes.css';
import './theme/base.css';
import './theme/fonts.css';
import './theme/buttons.css';
import './theme/fields.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { detectLanguage, initI18n } from './i18n';
import { isFileWindowLabel } from './ipc';
import { installRecorderEvents } from './features/audio/recorderStore';
import { installFileDropIfTauri } from './features/editor/attachments';
import { installFindMenuIfTauri } from './features/editor/findInPage';
import { installSeeAtomsMenuIfTauri } from './features/global-view/seeAtomsMenu';
import { installOpenFile, installOpenInVault } from './features/singleFile/openFile';
import { SingleFileApp } from './features/singleFile/SingleFileApp';
import { installFileWatch } from './features/singleFile/singleFileStore';
import { installSearchMenuIfTauri } from './features/search/searchMenu';
import { installSaveKey, installShellMenuIfTauri } from './features/shell/shellMenu';
import { installFindKey, installNoFindBar } from './features/shell/useGlobalShortcuts';
import { installQuitGuardIfTauri } from './stores/editorStore';
import { installMenuTogglesIfTauri } from './stores/menuToggles';
import { installMenuNavigationIfTauri } from './stores/navigate';
import { installSettingsSync, useSettingsStore } from './stores/settingsStore';
import { applyTheme } from './theme/theme';

applyTheme('system');

// A window showing one file opened on its own (M4c §3): no vault.
const singleFile = isFileWindowLabel();

// Saved settings (theme, language) apply before the first render.
void initI18n(detectLanguage(navigator.languages))
  .then(() => useSettingsStore.getState().load())
  .then(() => {
    installQuitGuardIfTauri();
    installMenuTogglesIfTauri();
    installShellMenuIfTauri(!singleFile);
    installSaveKey();
    installNoFindBar();
    installFindMenuIfTauri(!singleFile);
    installSettingsSync();
    installOpenFile();
    if (singleFile) {
      void installFileWatch().catch(() => undefined);
      // The main window's ⌘F is in its global shortcuts.
      installFindKey();
    } else {
      installMenuNavigationIfTauri();
      installSeeAtomsMenuIfTauri();
      installSearchMenuIfTauri();
      installFileDropIfTauri();
      installRecorderEvents();
      installOpenInVault();
    }
    createRoot(document.getElementById('root')!).render(
      <StrictMode>{singleFile ? <SingleFileApp /> : <App />}</StrictMode>,
    );
  });
