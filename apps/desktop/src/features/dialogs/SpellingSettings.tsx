import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  spellDictionaries,
  spellImport,
  spellRemove,
  spellRemoveWord,
  spellVaultGet,
  spellVaultSet,
  spellWords,
  type CommandError,
  type SpellDictionary,
} from '../../ipc';
import { SmallCloseIcon } from '../../app/icons';
import { errorMessage } from '../../stores/messages';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSpellStore } from '../../stores/spellStore';
import { useToastStore } from '../../stores/toastStore';
import styles from './Dialogs.module.css';

const BUNDLED_NAMES = new Set(['en_US', 'es', 'es_CO']);

const failed = (error: CommandError) =>
  useToastStore.getState().push({ message: errorMessage(error), tone: 'error' });

const bump = () => useSpellStore.getState().bump();

/** The language's dictionary, when none is chosen (spell checking spec §4). */
export const defaultDictionaries = (lang: string | undefined) => [
  lang?.startsWith('es') ? 'es' : 'en_US',
];

function useDictionaries() {
  const [list, setList] = useState<SpellDictionary[] | null>(null);
  const reload = useCallback(async () => {
    const res = await spellDictionaries();
    if (res.ok) setList(res.value);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { list, reload };
}

/** One checkbox per dictionary, in the list's order; `onToggle` gets the new
 *  set in that order. */
function DictionaryChecks({
  list,
  checked,
  onChange,
  onRemove,
}: {
  list: SpellDictionary[];
  checked: string[];
  onChange: (ids: string[]) => void;
  onRemove?: (d: SpellDictionary) => void;
}) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState<string | null>(null);
  const name = (d: SpellDictionary) =>
    BUNDLED_NAMES.has(d.id) ? t(`spelling.dict.${d.id}`) : d.name;
  const toggle = (id: string, on: boolean) =>
    onChange(list.map((d) => d.id).filter((x) => (x === id ? on : checked.includes(x))));
  return (
    <fieldset className={styles.fieldset}>
      <legend>{t('spelling.dictionaries')}</legend>
      {list.map((d) => (
        <div key={d.id} className={styles.check}>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={checked.includes(d.id)}
              disabled={!d.available}
              onChange={(e) => toggle(d.id, e.target.checked)}
            />
            {name(d)}
          </label>
          {!d.available && <span className={styles.hint}>{t('spelling.unavailable')}</span>}
          {onRemove && !d.bundled && asking !== d.id && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              aria-label={t('spelling.remove', { name: d.name })}
              onClick={() => setAsking(d.id)}
            >
              {t('spelling.removeShort')}
            </button>
          )}
          {onRemove && asking === d.id && (
            <div role="group" aria-label={t('spelling.removeAsk', { name: d.name })}>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => {
                  setAsking(null);
                  onRemove(d);
                }}
              >
                {t('spelling.removeShort')}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setAsking(null)}
              >
                {t('dialogs.cancel')}
              </button>
            </div>
          )}
        </div>
      ))}
      {!list.some((d) => d.available && checked.includes(d.id)) && (
        <p className={styles.hint} role="status">
          {t('spelling.noneSelected')}
        </p>
      )}
    </fieldset>
  );
}

/** Settings → Spelling: on/off, the app's dictionaries, importing, and the
 *  open vault's added words. */
export function SpellingSettings({ vaultOpen }: { vaultOpen: boolean }) {
  const { t, i18n } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const { list, reload } = useDictionaries();
  const [words, setWords] = useState<string[] | null>(null);
  const setKey = useSpellStore((s) => s.setKey);
  const stored = settings.spellDictionaries ?? defaultDictionaries(i18n.resolvedLanguage);
  // Quick clicks build on the last one, not on what has been saved so far.
  const [draft, setDraft] = useState<string[] | null>(null);
  const checked = draft ?? stored;
  useEffect(() => {
    setDraft((d) => (d && d.join() === stored.join() ? null : d));
  }, [stored]);

  useEffect(() => {
    if (!vaultOpen) return;
    void spellWords().then((r) => r.ok && setWords(r.value));
  }, [vaultOpen, setKey]);

  const save = async (patch: Parameters<typeof update>[0]) => {
    const res = await update(patch);
    if (res.ok) bump();
    else failed(res.error);
  };
  const add = async () => {
    const res = await spellImport();
    if (!res.ok) return failed(res.error);
    if (res.value) await reload();
  };
  const remove = async (d: SpellDictionary) => {
    const res = await spellRemove(d.id);
    if (!res.ok) return failed(res.error);
    await reload();
    await useSettingsStore.getState().load();
    bump();
  };
  // Removing a chip unmounts the focused button: the keyboard goes to the
  // chip now in its place, else the one before (as related-page chips do).
  const chips = useRef<HTMLUListElement>(null);
  const [refocus, setRefocus] = useState<number | null>(null);
  useEffect(() => {
    if (refocus === null) return;
    setRefocus(null);
    const buttons = chips.current?.querySelectorAll('button') ?? [];
    (buttons[refocus] ?? buttons[refocus - 1])?.focus();
  }, [refocus, words]);
  const removeWord = async (word: string, at: number) => {
    const res = await spellRemoveWord(word);
    if (!res.ok) return failed(res.error);
    setWords((w) => w?.filter((x) => x !== word) ?? null);
    setRefocus(at);
    bump();
  };

  return (
    <>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={settings.spellcheck}
          onChange={(e) => void save({ spellcheck: e.target.checked })}
        />
        {t('spelling.check')}
      </label>
      {list && (
        <DictionaryChecks
          list={list}
          checked={checked}
          onChange={(ids) => {
            setDraft(ids);
            void save({ spellDictionaries: ids });
          }}
          onRemove={(d) => void remove(d)}
        />
      )}
      <div>
        <button type="button" className="btn btn-secondary" onClick={() => void add()}>
          {t('spelling.import')}
        </button>
      </div>
      {vaultOpen && (
        <fieldset className={styles.fieldset}>
          <legend>{t('spelling.words')}</legend>
          {words && words.length === 0 && <p className={styles.hint}>{t('spelling.noWords')}</p>}
          {words && words.length > 0 && (
            <ul ref={chips} className={styles.chips} aria-label={t('spelling.words')}>
              {words.map((w, at) => (
                <li key={w} className={styles.chip}>
                  {w}
                  <button
                    type="button"
                    className={styles.chipRemove}
                    aria-label={t('spelling.removeWord', { word: w })}
                    title={t('spelling.removeWord', { word: w })}
                    onClick={() => void removeWord(w, at)}
                  >
                    <SmallCloseIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      )}
    </>
  );
}

/** This vault → Spelling: the app's dictionaries, or a set of its own. */
export function VaultSpelling() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const appSet = useSettingsStore((s) => s.settings.spellDictionaries);
  const { list } = useDictionaries();
  const [own, setOwn] = useState<string[] | null | undefined>(undefined);

  useEffect(() => {
    void spellVaultGet().then((r) => setOwn(r.ok ? r.value : null));
  }, []);

  const save = async (ids: string[] | null) => {
    const res = await spellVaultSet(ids);
    if (!res.ok) return failed(res.error);
    setOwn(ids);
    bump();
  };
  if (own === undefined) return null;

  return (
    <>
      <label className={styles.field} htmlFor={id}>
        <span>{t('spelling.vault')}</span>
        <select
          id={id}
          className="field-control"
          value={own ? 'custom' : 'app'}
          onChange={(e) =>
            void save(
              e.target.value === 'custom'
                ? (appSet ?? defaultDictionaries(i18n.resolvedLanguage))
                : null,
            )
          }
        >
          <option value="app">{t('spelling.vaultApp')}</option>
          <option value="custom">{t('spelling.vaultCustom')}</option>
        </select>
      </label>
      {own && list && (
        <DictionaryChecks list={list} checked={own} onChange={(ids) => void save(ids)} />
      )}
    </>
  );
}
