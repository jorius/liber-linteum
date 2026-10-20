import {
  useEffect,
  useId,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { PALETTE_IDS, themeExport, themeImport, type PaletteId } from '../../ipc';
import { useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import {
  badge,
  fillDerived,
  fix,
  newTheme,
  parseImport,
  resetColor,
  setColor,
  toExport,
  uniqueName,
  type CustomTheme,
  type Mode,
  type TokenKey,
} from '../../theme/customThemes';
import { PALETTES, type Palette, type PaletteTokens } from '../../theme/palettes';
import styles from './ThemeSettings.module.css';
import { useLatestSave } from './useLatestSave';

/** The editor's groups (custom themes §3, mock A); Accents fold away. */
const GROUPS: { key: string; tokens: TokenKey[]; folded?: boolean }[] = [
  { key: 'brand', tokens: ['accent', 'secondary'] },
  { key: 'surfaces', tokens: ['bg', 'surface', 'border', 'side', 'sideText', 'sideSel'] },
  { key: 'text', tokens: ['strong', 'body', 'text', 'muted', 'contrast'] },
  { key: 'accents', tokens: ['soft', 'mark', 'code'], folded: true },
];
const HEX = /^#[0-9a-f]{6}$/i;
const RGBA = /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\)$/i;

/** Settings → Appearance: built-in palettes and the user's own themes as
 *  cards, and the full editor for the selected own theme (custom themes §3). */
export function ThemeSettings() {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const themes = settings.customThemes;
  const selected =
    settings.palette === 'custom' ? themes.find((x) => x.id === settings.customTheme) : undefined;
  const builtIn = settings.palette === 'custom' && selected ? undefined : settings.palette;
  const current: Palette = selected
    ? { id: 'custom', light: selected.light, dark: selected.dark }
    : (PALETTES.find((p) => p.id === builtIn) ?? PALETTES[0]);
  const names = themes.map((x) => x.name);

  const add = (theme: CustomTheme) =>
    update({ customThemes: [...themes, theme], palette: 'custom', customTheme: theme.id });
  const importFile = async () => {
    const res = await themeImport();
    if (!res.ok || res.value === null) return;
    const parsed = parseImport(res.value);
    if (!parsed.ok) {
      useToastStore.getState().push({
        message: t('settings.themes.importFailed'),
        detail: [t(`settings.themes.importReason.${parsed.reason}`)],
        tone: 'error',
      });
      return;
    }
    const { light, dark } = parsed.theme;
    const theme = newTheme({ id: 'custom', light, dark }, uniqueName(parsed.theme.name, names));
    await add(theme);
  };

  return (
    <div className={styles.root}>
      <Gallery
        label={t('settings.themes.builtIn')}
        items={PALETTE_IDS.map((id) => ({
          id,
          name: t(`settings.palettes.${id}`),
          tokens: PALETTES.find((p) => p.id === id)!.light,
          chosen: builtIn === id,
        }))}
        onPick={(id) => void update({ palette: id as PaletteId })}
      />
      <Gallery
        label={t('settings.themes.mine')}
        items={themes.map((x) => ({
          id: x.id,
          name: x.name,
          tokens: x.light,
          chosen: selected?.id === x.id,
        }))}
        onPick={(id) => void update({ palette: 'custom', customTheme: id })}
      >
        <button
          type="button"
          className={styles.newCard}
          onClick={() =>
            void add(newTheme(current, uniqueName(t('settings.themes.newName'), names)))
          }
        >
          {t('settings.themes.new')}
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => void importFile()}>
          {t('settings.themes.import')}
        </button>
      </Gallery>
      {selected ? (
        <Editor key={selected.id} theme={selected} />
      ) : (
        <div className={styles.builtInNote}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() =>
              void add(
                newTheme(
                  current,
                  uniqueName(
                    t('settings.themes.copyName', { name: t(`settings.palettes.${builtIn}`) }),
                    names,
                  ),
                ),
              )
            }
          >
            {t('settings.themes.duplicateToEdit')}
          </button>
        </div>
      )}
    </div>
  );
}

interface GalleryItem {
  id: string;
  name: string;
  tokens: PaletteTokens;
  chosen: boolean;
}

/** A row of theme cards: one radio group (arrow keys move between them). */
function Gallery({
  label,
  items,
  onPick,
  children,
}: {
  label: string;
  items: GalleryItem[];
  onPick: (id: string) => void;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={styles.galleryBlock}>
      <span className={styles.label} id={id}>
        {label}
      </span>
      <div className={styles.gallery}>
        <div role="radiogroup" aria-labelledby={id} className={styles.cards}>
          {items.map((it) => (
            <label key={it.id} className={`${styles.card} ${it.chosen ? styles.chosen : ''}`}>
              <input
                type="radio"
                className={styles.radio}
                name={id}
                checked={it.chosen}
                onChange={() => onPick(it.id)}
              />
              <Mini tokens={it.tokens} />
              <span className={styles.cardName}>{it.name}</span>
            </label>
          ))}
        </div>
        {children}
      </div>
    </div>
  );
}

/** A card's thumbnail: sidebar, page, primary and secondary bars. */
function Mini({ tokens }: { tokens: PaletteTokens }) {
  return (
    <span className={styles.mini} aria-hidden="true">
      <span style={{ background: tokens.side }} />
      <span className={styles.miniPage} style={{ background: tokens.bg }}>
        <i style={{ background: tokens.accent, width: '60%' }} />
        <i style={{ background: tokens.secondary, width: '40%' }} />
        <i style={{ background: tokens.border, width: '75%' }} />
      </span>
    </span>
  );
}

/** The full editor for one of the user's themes. */
function Editor({ theme }: { theme: CustomTheme }) {
  const { t } = useTranslation();
  const update = useSettingsStore((s) => s.update);
  const [draft, setDraft] = useState(theme);
  const [mode, setMode] = useState<Mode>('light');
  const [name, setName] = useState(theme.name);
  const [more, setMore] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const saver = useLatestSave((next: CustomTheme) =>
    update({
      customThemes: useSettingsStore
        .getState()
        .settings.customThemes.map((x) => (x.id === next.id ? next : x)),
    }),
  );
  // Follow the saved theme, but not while a newer edit is on its way.
  useEffect(() => {
    if (!saver.pending()) setDraft(theme);
  }, [theme, saver]);

  const edit = (next: CustomTheme, now = false) => {
    setDraft(next);
    if (now) saver.now(next);
    else saver.schedule(next);
  };
  const commitName = () => {
    const trimmed = name.trim();
    if (!trimmed) setName(draft.name);
    else if (trimmed !== draft.name) edit({ ...draft, name: trimmed }, true);
  };
  const list = () => useSettingsStore.getState().settings.customThemes;
  const remove = () =>
    update({
      customThemes: list().filter((x) => x.id !== draft.id),
      palette: 'lavender',
      customTheme: '',
    });
  const duplicate = () => {
    const copy = newTheme(
      { id: 'custom', light: draft.light, dark: draft.dark },
      uniqueName(
        t('settings.themes.copyName', { name: draft.name }),
        list().map((x) => x.name),
      ),
    );
    void update({ customThemes: [...list(), copy], palette: 'custom', customTheme: copy.id });
  };

  return (
    <section
      className={styles.editor}
      aria-label={t('settings.themes.editing', { name: draft.name })}
    >
      <div className={styles.editorHead}>
        <input
          type="text"
          className={`field-control ${styles.nameField}`}
          aria-label={t('settings.themes.name')}
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitName();
            }
          }}
        />
        <div className={styles.segmented} role="group" aria-label={t('settings.themes.mode')}>
          {(['light', 'dark'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
              {t(`settings.themes.${m}`)}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.editorBody}>
        <div className={styles.groups}>
          {GROUPS.filter((g) => more || !g.folded).map((g) => (
            <fieldset key={g.key} className={styles.group}>
              <legend>{t(`settings.themes.groups.${g.key}`)}</legend>
              {g.tokens.map((k) => (
                <TokenRow
                  key={`${mode}-${k}`}
                  theme={draft}
                  mode={mode}
                  token={k}
                  onChange={(next) => edit(next)}
                />
              ))}
            </fieldset>
          ))}
          <button
            type="button"
            className={styles.more}
            aria-expanded={more}
            onClick={() => setMore(!more)}
          >
            {more
              ? t('settings.themes.fewer')
              : t('settings.themes.more', {
                  count: GROUPS.filter((g) => g.folded).flatMap((g) => g.tokens).length,
                })}
          </button>
          <div className={styles.actions}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => edit(fillDerived(draft), true)}
            >
              {t('settings.themes.fill')}
            </button>
            <button type="button" className="btn btn-secondary" onClick={duplicate}>
              {t('settings.themes.duplicate')}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void themeExport(draft.name, toExport(draft))}
            >
              {t('settings.themes.export')}
            </button>
            {confirming ? (
              <span className={styles.confirm}>
                <button type="button" className="btn btn-danger" onClick={() => void remove()}>
                  {t('settings.themes.deleteNamed', { name: draft.name })}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setConfirming(false)}
                >
                  {t('dialogs.cancel')}
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirming(true)}
              >
                {t('settings.themes.delete')}
              </button>
            )}
          </div>
        </div>
        <Preview tokens={draft[mode]} />
      </div>
    </section>
  );
}

/** One colour: swatch picker, hex field, readability badge, Fix and reset. */
function TokenRow({
  theme,
  mode,
  token,
  onChange,
}: {
  theme: CustomTheme;
  mode: Mode;
  token: TokenKey;
  onChange: (next: CustomTheme) => void;
}) {
  const { t } = useTranslation();
  const value = theme[mode][token];
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const name = t(`settings.themes.tokens.${token}.name`);
  const b = badge(theme, mode, token);
  const handSet = !theme.derived[mode].includes(token);
  const valid = (v: string) => HEX.test(v) || (token === 'sideSel' && RGBA.test(v));
  // A valid value saves as it is typed (so closing the dialog keeps it); an
  // invalid one reverts on blur.
  const type = (next: string) => {
    setText(next);
    const v = next.trim().toLowerCase();
    if (valid(v) && v !== value) onChange(setColor(theme, mode, token, v));
  };
  const commit = () => {
    if (!valid(text.trim().toLowerCase())) setText(value);
  };
  return (
    <div role="group" aria-label={name} className={styles.row}>
      {HEX.test(value) ? (
        <input
          type="color"
          className={styles.swatch}
          aria-label={t('settings.themes.colour', { name })}
          value={value}
          onChange={(e) => onChange(setColor(theme, mode, token, e.target.value.toLowerCase()))}
        />
      ) : (
        <span className={styles.swatch} style={{ background: value }} aria-hidden="true" />
      )}
      <span className={styles.rowText}>
        <span className={styles.rowName}>{name}</span>
        <span className={styles.rowUse}>{t(`settings.themes.tokens.${token}.use`)}</span>
      </span>
      <input
        type="text"
        className={`field-control ${styles.hex}`}
        aria-label={t('settings.themes.colourHex', { name })}
        spellCheck={false}
        value={text}
        onChange={(e) => type(e.target.value)}
        onBlur={commit}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      {b && (
        <span className={styles.badge} data-level={b.level}>
          {b.level} {b.ratio.toFixed(1)}
        </span>
      )}
      {b?.level === 'Low' && (
        <button
          type="button"
          className={styles.small}
          aria-label={t('settings.themes.fixNamed', { name })}
          onClick={() => onChange(setColor(theme, mode, token, fix(value, b.bgs)))}
        >
          {t('settings.themes.fix')}
        </button>
      )}
      {handSet && (
        <button
          type="button"
          className={styles.small}
          aria-label={t('settings.themes.resetNamed', { name })}
          title={t('settings.themes.reset')}
          onClick={() => onChange(resetColor(theme, mode, token))}
        >
          ↺
        </button>
      )}
    </div>
  );
}

/** A small live sample of the edited mode (custom themes §3). */
function Preview({ tokens }: { tokens: PaletteTokens }) {
  const { t } = useTranslation();
  const v = {
    '--p-bg': tokens.bg,
    '--p-surface': tokens.surface,
    '--p-border': tokens.border,
    '--p-strong': tokens.strong,
    '--p-body': tokens.body,
    '--p-muted': tokens.muted,
    '--p-accent': tokens.accent,
    '--p-contrast': tokens.contrast,
    '--p-secondary': tokens.secondary,
    '--p-mark': tokens.mark,
    '--p-side': tokens.side,
    '--p-side-text': tokens.sideText,
    '--p-side-sel': tokens.sideSel,
  } as CSSProperties;
  return (
    <figure className={styles.preview} style={v} aria-label={t('settings.themes.preview')}>
      <span className={styles.pvSide} aria-hidden="true">
        <i />
        <i data-sel />
        <i />
      </span>
      <span className={styles.pvMain}>
        <span className={styles.pvCard}>
          <strong>{t('settings.themes.sample.title')}</strong>
          <span>
            {t('settings.themes.sample.before')}{' '}
            <u className={styles.pvLink}>{t('settings.themes.sample.link')}</u>{' '}
            <span className={styles.pvTag}>#{t('settings.themes.sample.tag')}</span>{' '}
            <mark className={styles.pvMark}>{t('settings.themes.sample.highlight')}</mark>
          </span>
          <small>{t('settings.themes.sample.meta')}</small>
          <span className={styles.pvButtons}>
            <span className={styles.pvPrimary}>{t('settings.themes.sample.primary')}</span>
            <span className={styles.pvSecondary}>{t('settings.themes.sample.secondary')}</span>
          </span>
        </span>
      </span>
    </figure>
  );
}
