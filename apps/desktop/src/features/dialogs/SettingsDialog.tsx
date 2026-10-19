import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES } from '../../i18n';
import { fontsList, PALETTE_IDS, type PaletteChoice, type Theme } from '../../ipc';
import { useSettingsStore } from '../../stores/settingsStore';
import { useVaultStore } from '../../stores/vaultStore';
import { contrast } from '../../theme/color';
import { derive } from '../../theme/derive';
import { LIVE_FONTS, SOURCE_FONTS, systemChoice, type FontOption } from '../../theme/fonts';
import { PALETTES } from '../../theme/palettes';
import { Dialog } from './Dialog';
import styles from './Dialogs.module.css';
import { useLatestSave } from './useLatestSave';
import { VaultSettingsSection } from './VaultSettingsSection';

const THEMES: Theme[] = ['system', 'light', 'dark'];
const themeKey = { system: 'themeSystem', light: 'themeLight', dark: 'themeDark' } as const;
const PALETTE_CHOICES: PaletteChoice[] = [...PALETTE_IDS, 'custom'];
const SIZES = [13, 14, 15, 16, 17, 18, 19, 20];
const HEX = /^#[0-9a-f]{6}$/i;

/** Language, appearance (theme, palette, custom accent), editor (fonts, text
 *  size, toolbar), file settings and, with a vault open, where its
 *  attachments go (M2c §5.4); every change is saved at once (M2b §7). */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const installed = useInstalledFonts();
  const ids = { appearance: useId(), editor: useId(), files: useId() };
  const vaultOpen = useVaultStore((s) => s.info !== null);

  return (
    <Dialog title={t('settings.title')} onClose={onClose}>
      <label className={styles.field}>
        <span>{t('settings.language')}</span>
        <select
          className={styles.select}
          value={settings.language ?? 'system'}
          onChange={(e) => void update({ language: e.target.value })}
        >
          <option value="system">{t('settings.languageSystem')}</option>
          {SUPPORTED_LANGUAGES.map((lng) => (
            <option key={lng} value={lng} lang={lng}>
              {t(`languages.${lng}`)}
            </option>
          ))}
        </select>
      </label>

      <section className={styles.section} aria-labelledby={ids.appearance}>
        <h3 id={ids.appearance} className={styles.sectionTitle}>
          {t('settings.sections.appearance')}
        </h3>
        <fieldset className={styles.fieldset}>
          <legend>{t('settings.theme')}</legend>
          {THEMES.map((theme) => (
            <label key={theme} className={styles.check}>
              <input
                type="radio"
                name="theme"
                value={theme}
                checked={settings.theme === theme}
                onChange={() => void update({ theme })}
              />
              {t(`settings.${themeKey[theme]}`)}
            </label>
          ))}
        </fieldset>
        <fieldset className={`${styles.fieldset} ${styles.palettes}`}>
          <legend>{t('settings.palette')}</legend>
          {PALETTE_CHOICES.map((id) => (
            <label key={id} className={styles.palette}>
              <input
                type="radio"
                name="palette"
                value={id}
                checked={settings.palette === id}
                onChange={() => void update({ palette: id })}
              />
              <Swatch id={id} accent={settings.accentColor} />
              <span>{t(`settings.palettes.${id}`)}</span>
            </label>
          ))}
        </fieldset>
        {settings.palette === 'custom' && (
          <AccentEditor
            value={settings.accentColor}
            onSave={(accentColor) => update({ accentColor })}
          />
        )}
      </section>

      <section className={styles.section} aria-labelledby={ids.editor}>
        <h3 id={ids.editor} className={styles.sectionTitle}>
          {t('settings.sections.editor')}
        </h3>
        <FontSelect
          label={t('settings.fontLive')}
          fonts={LIVE_FONTS}
          installed={installed}
          value={settings.fontLivePreview}
          onChange={(fontLivePreview) => void update({ fontLivePreview })}
        />
        <FontSelect
          label={t('settings.fontSource')}
          fonts={SOURCE_FONTS}
          installed={installed}
          value={settings.fontSource}
          onChange={(fontSource) => void update({ fontSource })}
        />
        <label className={styles.field}>
          <span>{t('settings.fontSize')}</span>
          <select
            className={styles.select}
            value={settings.fontSize}
            onChange={(e) => void update({ fontSize: Number(e.target.value) })}
          >
            {SIZES.map((px) => (
              <option key={px} value={px}>
                {t('settings.fontSizePx', { px })}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={settings.toolbar}
            onChange={(e) => void update({ toolbar: e.target.checked })}
          />
          {t('settings.toolbar')}
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={settings.lineNumbers}
            onChange={(e) => void update({ lineNumbers: e.target.checked })}
          />
          {t('settings.lineNumbers')}
        </label>
      </section>

      <section className={styles.section} aria-labelledby={ids.files}>
        <h3 id={ids.files} className={styles.sectionTitle}>
          {t('settings.sections.files')}
        </h3>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={settings.rewriteLinks}
            onChange={(e) => void update({ rewriteLinks: e.target.checked })}
          />
          {t('settings.rewriteLinks')}
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={settings.confirmDelete}
            onChange={(e) => void update({ confirmDelete: e.target.checked })}
          />
          {t('settings.confirmDelete')}
        </label>
      </section>

      {vaultOpen && <VaultSettingsSection />}

      <div className={styles.buttons}>
        <button type="button" className={`${styles.button} ${styles.primary}`} onClick={onClose}>
          {t('dialogs.close')}
        </button>
      </div>
    </Dialog>
  );
}

/** Installed font families (empty outside the app or on error). */
function useInstalledFonts(): string[] {
  const [families, setFamilies] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void fontsList().then((res) => {
      if (live && res.ok && Array.isArray(res.value)) setFamilies(res.value);
    });
    return () => {
      live = false;
    };
  }, []);
  return families;
}

/** Light and dark background + accent of a palette, as four chips. */
function Swatch({ id, accent }: { id: PaletteChoice; accent: string }) {
  const p = id === 'custom' ? derive(accent) : PALETTES.find((x) => x.id === id)!;
  return (
    <span className={styles.chips} aria-hidden="true">
      {[p.light.bg, p.light.accent, p.dark.bg, p.dark.accent].map((c, i) => (
        <span key={i} className={styles.chip} style={{ background: c }} />
      ))}
    </span>
  );
}

/** Colour picker + hex field for the custom accent, with the contrast the
 *  derived palette reaches in each mode. The picker previews locally while
 *  dragging and saves the settled colour; the last colour always wins. */
function AccentEditor({
  value,
  onSave,
}: {
  value: string;
  onSave: (hex: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const errorId = useId();
  const saver = useLatestSave(onSave);
  // Follow the saved value, but not while a newer colour is on its way.
  useEffect(() => {
    if (!saver.pending()) setDraft(value);
  }, [value, saver]);
  const shown = HEX.test(draft) ? draft.toLowerCase() : value;
  const p = derive(shown);

  const commit = () => {
    if (!HEX.test(draft)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const hex = draft.toLowerCase();
    if (hex !== value || saver.pending()) saver.now(hex);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
  };

  return (
    <div className={styles.accent}>
      <div className={styles.accentRow}>
        <input
          type="color"
          className={styles.colorInput}
          aria-label={t('settings.accentColor')}
          value={shown}
          onChange={(e) => {
            const hex = e.target.value.toLowerCase();
            setDraft(hex);
            setInvalid(false);
            saver.schedule(hex);
          }}
        />
        <input
          type="text"
          className={styles.hexInput}
          aria-label={t('settings.accentHex')}
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
          spellCheck={false}
          value={draft}
          onChange={(e) => {
            const next = e.target.value.trim();
            setDraft(next);
            if (HEX.test(next)) setInvalid(false);
          }}
          onKeyDown={onKeyDown}
          onBlur={commit}
        />
      </div>
      {invalid && (
        <p id={errorId} role="alert" className={styles.error}>
          {t('settings.accentInvalid')}
        </p>
      )}
      <p className={styles.hint}>
        {t('settings.accentContrast', {
          light: contrast(p.light.accent, p.light.surface).toFixed(1),
          dark: contrast(p.dark.accent, p.dark.surface).toFixed(1),
        })}
      </p>
    </div>
  );
}

/** Bundled fonts, then the fonts installed on this computer. */
function FontSelect({
  label,
  fonts,
  installed,
  value,
  onChange,
}: {
  label: string;
  fonts: readonly FontOption[];
  installed: string[];
  value: string;
  onChange: (choice: string) => void;
}) {
  const { t } = useTranslation();
  const known = new Set([...fonts.map((f) => f.id), ...installed.map(systemChoice)]);
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <select className={styles.select} value={value} onChange={(e) => onChange(e.target.value)}>
        <optgroup label={t('settings.fontBundled')}>
          {fonts.map((f) => (
            <option key={f.id} value={f.id} style={{ fontFamily: f.stack }}>
              {f.label ?? t('settings.fontSystemDefault')}
            </option>
          ))}
        </optgroup>
        {(installed.length > 0 || !known.has(value)) && (
          <optgroup label={t('settings.fontInstalled')}>
            {!known.has(value) && value.startsWith('system:') && (
              <option value={value}>{value.slice('system:'.length)}</option>
            )}
            {installed.map((family) => (
              <option
                key={family}
                value={systemChoice(family)}
                style={{ fontFamily: `"${family}"` }}
              >
                {family}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}
