// New Quick Note (M4c §2, §7): from the Welcome screen, File → New Quick
// Note and ⌘⇧N. With a vault open the note goes into its scratch place (Rust
// picks it); with none, into the global Scratchpad, chosen on first use.
import i18next from 'i18next';
import { quickNoteCreate } from '../../ipc';
import { openPageAt } from '../../stores/navigate';
import { errorMessage } from '../../stores/messages';
import { useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { parentOf } from '../../stores/tree';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { useScratchpadStore } from './scratchpadStore';

/** A second trigger this soon is the same press (the macOS menu accelerator
 *  and the page both answer ⌘⇧N; §7.10). */
export const QUICK_NOTE_COOLDOWN_MS = 1000;

let lastStart = Number.NEGATIVE_INFINITY;
let running = false;

const pad = (n: number) => String(n).padStart(2, '0');

/** `Quick note 2026-10-15 09.05` (local time; `Nota rápida …` in Spanish). */
export function quickNoteName(date: Date): string {
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}.${pad(date.getMinutes())}`;
  return i18next.t('scratchpad.noteName', { stamp });
}

/** Takes a quick note, unless one was just started or a vault is opening. */
export async function newQuickNote(): Promise<void> {
  const now = Date.now();
  if (running || now - lastStart < QUICK_NOTE_COOLDOWN_MS) return;
  if (useVaultStore.getState().status === 'opening') return;
  lastStart = now;
  running = true;
  try {
    await takeQuickNote();
  } finally {
    running = false;
  }
}

/** The quick note itself (the first-use dialog continues here). */
export async function takeQuickNote(): Promise<void> {
  const vault = useVaultStore.getState();
  if (vault.status !== 'open') {
    if (!useSettingsStore.getState().settings.scratchpadPath) {
      askWhere();
      return;
    }
    const opened = await vault.openScratchpad();
    if (!opened.ok) {
      // The open said why (a toast); offer another folder (§7.18).
      askWhere();
      return;
    }
  }
  const res = await quickNoteCreate(quickNoteName(new Date()));
  if (!res.ok) {
    useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
    return;
  }
  const path = res.value;
  useScratchpadStore.getState().add(path);
  await useVaultStore.getState().refreshTree();
  const dir = parentOf(path);
  if (dir) useVaultStore.getState().expand(dir);
  // The cursor in the text (§2).
  await openPageAt(path, 0, 0);
}

function askWhere() {
  useUiStore.getState().openDialog({ type: 'scratchpadSetup', then: 'quickNote' });
}
