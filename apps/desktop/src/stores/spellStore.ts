// Spell checking's shared state: `setKey` changes whenever what counts as
// correct changes (dictionaries, the vault's override or words, an ignore,
// another vault), so every editor drops its cached answers and re-checks.
import i18n from 'i18next';
import { create } from 'zustand';

interface SpellState {
  setKey: number;
  bump: () => void;
}

export const useSpellStore = create<SpellState>((set) => ({
  setKey: 0,
  bump: () => set((s) => ({ setKey: s.setKey + 1 })),
}));

// Without a chosen dictionary the UI language picks one (round 3b final
// review #8).
i18n.on('languageChanged', () => useSpellStore.getState().bump());
