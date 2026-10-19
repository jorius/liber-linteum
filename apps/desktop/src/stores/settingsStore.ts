import i18next from 'i18next';
import { create } from 'zustand';
import { detectLanguage } from '../i18n';
import {
  settingsGet,
  settingsSet,
  type IpcResult,
  type Settings,
  type SettingsPatch,
} from '../ipc';
import { applyAppearance } from '../theme/appearance';
import { applyTheme } from '../theme/theme';
import { useToastStore } from './toastStore';

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  language: null,
  theme: 'system',
  rewriteLinks: true,
  confirmDelete: true,
  editorMode: 'livePreview',
  palette: 'lavender',
  accentColor: '#d1477a',
  fontLivePreview: 'atkinson-hyperlegible',
  fontSource: 'jetbrains-mono',
  fontSize: 15,
  toolbar: true,
  lineNumbers: false,
  pageWidth: 'readable',
  wideElements: { tables: true, code: false, diagrams: true, images: false, maths: false },
  outline: false,
  coverHeight: 200,
  showAttachmentPaths: false,
  globalViewMode: 'drill',
  globalViewEdges: { links: true, tree: true, manual: true, aggregated: true },
};

interface SettingsState {
  settings: Settings;
  warning: string | null;
  loaded: boolean;
  /** Called before the first render (main.tsx). */
  load: () => Promise<void>;
  update: (patch: SettingsPatch) => Promise<IpcResult<Settings>>;
}

async function apply(s: Settings) {
  applyTheme(s.theme);
  applyAppearance(s);
  const lang = s.language ?? detectLanguage(navigator.languages);
  if (i18next.language !== lang) await i18next.changeLanguage(lang);
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: DEFAULT_SETTINGS,
  warning: null,
  loaded: false,
  load: async () => {
    const res = await settingsGet();
    // Outside Tauri (plain browser) or on error: defaults.
    const settings = res.ok ? { ...DEFAULT_SETTINGS, ...res.value.settings } : DEFAULT_SETTINGS;
    await apply(settings);
    const warning = res.ok ? (res.value.warning ?? null) : null;
    set({ settings, warning, loaded: true });
    if (warning) {
      useToastStore.getState().push({
        message: i18next.t('toasts.settingsWarning'),
        detail: [warning],
        tone: 'error',
      });
    }
  },
  update: async (patch) => {
    const res = await settingsSet(patch);
    if (res.ok) {
      const settings = { ...DEFAULT_SETTINGS, ...res.value };
      await apply(settings);
      set({ settings });
    }
    return res;
  },
}));
