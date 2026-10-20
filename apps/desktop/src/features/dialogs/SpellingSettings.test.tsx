import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18next from 'i18next';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SpellDictionary } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useSpellStore } from '../../stores/spellStore';
import { SpellingSettings, VaultSpelling } from './SpellingSettings';

const BUNDLED: SpellDictionary[] = [
  { id: 'en_US', name: 'English (US)', bundled: true, available: true },
  { id: 'es', name: 'Spanish', bundled: true, available: true },
  { id: 'es_CO', name: 'Spanish (Colombia)', bundled: true, available: true },
];

let dictionaries: SpellDictionary[];
let vaultIds: string[] | null;
let words: string[];
let calls: { cmd: string; args: Record<string, unknown> }[];

beforeEach(async () => {
  dictionaries = [...BUNDLED];
  vaultIds = null;
  words = ['Ioque', 'parcero'];
  calls = [];
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true });
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    switch (cmd) {
      case 'spell_dictionaries':
        return dictionaries;
      case 'spell_import': {
        const d = { id: 'user:mine', name: 'Mine', bundled: false, available: true };
        dictionaries = [...dictionaries, d];
        return d;
      }
      case 'spell_remove':
        dictionaries = dictionaries.filter((d) => d.id !== a.id);
        return null;
      case 'spell_vault_get':
        return vaultIds;
      case 'spell_vault_set':
        vaultIds = a.ids as string[] | null;
        return null;
      case 'spell_words':
        return words;
      case 'spell_remove_word':
        words = words.filter((w) => w !== a.word);
        return null;
      case 'settings_get':
        return { settings: useSettingsStore.getState().settings };
      case 'settings_set':
        return { ...useSettingsStore.getState().settings, ...(a.patch as object) };
      default:
        return null;
    }
  });
  await i18next.changeLanguage('es');
});

afterEach(async () => {
  clearMocks();
  await i18next.changeLanguage('en');
});

const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;

describe('SpellingSettings', () => {
  it('shows the three bundled dictionaries with the language default checked', async () => {
    render(<SpellingSettings vaultOpen={false} />);
    await waitFor(() => expect(box('Español')).toBeTruthy());
    expect(box('Revisar la ortografía').checked).toBe(true);
    expect(box('Inglés (EE. UU.)').checked).toBe(false);
    expect(box('Español').checked).toBe(true);
    expect(box('Español (Colombia)').checked).toBe(false);
  });

  it('checking a second dictionary saves spellDictionaries in list order and bumps', async () => {
    const before = useSpellStore.getState().setKey;
    render(<SpellingSettings vaultOpen={false} />);
    await waitFor(() => expect(box('Español (Colombia)')).toBeTruthy());
    fireEvent.click(box('Español (Colombia)'));
    fireEvent.click(box('Inglés (EE. UU.)'));
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === 'settings_set').at(-1)?.args).toEqual({
        patch: { spellDictionaries: ['en_US', 'es', 'es_CO'] },
      }),
    );
    expect(useSpellStore.getState().setKey).toBeGreaterThan(before);
  });

  // Round 3b final review #2.
  it('says so when no dictionary is selected', async () => {
    render(<SpellingSettings vaultOpen={false} />);
    await waitFor(() => expect(box('Español')).toBeTruthy());
    expect(screen.queryByText(/Ningún diccionario seleccionado/)).toBeNull();
    fireEvent.click(box('Español'));
    expect(
      await screen.findByText('Ningún diccionario seleccionado: no se revisa la ortografía'),
    ).toBeTruthy();
  });

  it('turning spelling off saves it', async () => {
    render(<SpellingSettings vaultOpen={false} />);
    fireEvent.click(box('Revisar la ortografía'));
    await waitFor(() =>
      expect(calls).toContainEqual({ cmd: 'settings_set', args: { patch: { spellcheck: false } } }),
    );
  });

  it('import adds a row; Remove asks, then deletes it', async () => {
    render(<SpellingSettings vaultOpen={false} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Agregar diccionario desde el disco…' }),
    );
    await waitFor(() => expect(box('Mine')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Quitar Mine' }));
    const ask = screen.getByRole('group', { name: '¿Quitar Mine?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Quitar' }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Mine' })).toBeNull());
    expect(calls).toContainEqual({ cmd: 'spell_remove', args: { id: 'user:mine' } });
  });

  it('an unavailable imported dictionary is disabled with its note', async () => {
    dictionaries.push({ id: 'user:old', name: 'Old', bundled: false, available: false });
    render(<SpellingSettings vaultOpen={false} />);
    await waitFor(() => expect(box('Old').disabled).toBe(true));
    expect(screen.getByText('No se pudo cargar')).toBeTruthy();
  });

  it('lists the vault words and removes one', async () => {
    render(<SpellingSettings vaultOpen />);
    await waitFor(() => expect(screen.getByText('Ioque')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Quitar Ioque' }));
    await waitFor(() => expect(screen.queryByText('Ioque')).toBeNull());
    expect(calls).toContainEqual({ cmd: 'spell_remove_word', args: { word: 'Ioque' } });
  });

  it('shows no word list without a vault', async () => {
    render(<SpellingSettings vaultOpen={false} />);
    await waitFor(() => expect(box('Español')).toBeTruthy());
    expect(screen.queryByText('Palabras agregadas en esta bóveda')).toBeNull();
  });
});

describe('VaultSpelling', () => {
  it('choosing a custom set calls spell_vault_set; back to the app clears it', async () => {
    render(<VaultSpelling />);
    const select = (await screen.findByRole('combobox', {
      name: 'Ortografía',
    })) as HTMLSelectElement;
    expect(select.value).toBe('app');
    fireEvent.change(select, { target: { value: 'custom' } });
    await waitFor(() =>
      expect(calls).toContainEqual({ cmd: 'spell_vault_set', args: { ids: ['es'] } }),
    );
    fireEvent.click(box('Español (Colombia)'));
    await waitFor(() =>
      expect(calls).toContainEqual({ cmd: 'spell_vault_set', args: { ids: ['es', 'es_CO'] } }),
    );
    fireEvent.change(select, { target: { value: 'app' } });
    await waitFor(() =>
      expect(calls).toContainEqual({ cmd: 'spell_vault_set', args: { ids: null } }),
    );
  });
});
