import i18next from 'i18next';
import { create } from 'zustand';
import { detectLanguage } from '../i18n';
import {
  isTauri,
  onSettingsChanged,
  settingsGet,
  settingsSet,
  type IpcResult,
  type Settings,
  type SettingsPatch,
} from '../ipc';
import { applyAppearance } from '../theme/appearance';
import { migrateLegacy } from '../theme/customThemes';
import { applyTheme } from '../theme/theme';
import { useToastStore } from './toastStore';

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  autoLockMinutes: 15,
  language: null,
  theme: 'system',
  rewriteLinks: true,
  confirmDelete: true,
  editorMode: 'livePreview',
  palette: 'lavender',
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
  scratchpadPath: null,
  autoSave: true,
  sidebarCollapsed: false,
  sidebarWidth: 270,
  actionButton: 'bottomRight',
  spellcheck: true,
  customThemes: [],
  customTheme: null,
  spellDictionaries: null,
  importedDictionaries: [],
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
  /** Shows settings saved by another window (nothing is written). */
  adopt: (settings: Settings) => Promise<void>;
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
    let settings = res.ok ? { ...DEFAULT_SETTINGS, ...res.value.settings } : DEFAULT_SETTINGS;
    await apply(settings);
    // Custom themes §2: a custom accent from before custom themes becomes a
    // theme, once (after `apply`, so its name is in the user's language).
    if (
      settings.palette === 'custom' &&
      settings.customThemes.length === 0 &&
      settings.accentColor
    ) {
      const theme = migrateLegacy(settings.accentColor, i18next.t('settings.themes.legacyName'));
      const patch = { customThemes: [theme], customTheme: theme.id };
      settings = { ...settings, ...patch };
      await apply(settings);
      // The legacy accent goes in the same save; if that fails it stays, and
      // the next load tries again (this session already looks right).
      const saved = await settingsSet({ ...patch, accentColor: '' });
      if (saved.ok) settings = { ...DEFAULT_SETTINGS, ...saved.value };
      else
        useToastStore.getState().push({
          message: i18next.t('settings.themes.migrateFailed'),
          detail: [saved.error.message],
          tone: 'error',
        });
    }
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
  adopt: async (next) => {
    const settings = { ...DEFAULT_SETTINGS, ...next };
    await apply(settings);
    set({ settings });
  },
}));

/** Settings changed in another window (M4c §3) show here too. */
export function installSettingsSync(): void {
  if (!isTauri()) return;
  void onSettingsChanged((s) => void useSettingsStore.getState().adopt(s)).catch(() => undefined);
}
