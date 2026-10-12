import './theme/tokens.css';
import './theme/base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { detectLanguage, initI18n } from './i18n';
import { applyTheme } from './theme/theme';

applyTheme('system');

void initI18n(detectLanguage(navigator.languages)).then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
