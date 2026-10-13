import './theme/tokens.css';
import './theme/palettes.css';
import './theme/base.css';
import './theme/fonts.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { detectLanguage, initI18n } from './i18n';
import { installQuitGuardIfTauri } from './stores/editorStore';
import { useSettingsStore } from './stores/settingsStore';
import { applyTheme } from './theme/theme';

applyTheme('system');

// Saved settings (theme, language) apply before the first render.
void initI18n(detectLanguage(navigator.languages))
  .then(() => useSettingsStore.getState().load())
  .then(() => {
    installQuitGuardIfTauri();
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
