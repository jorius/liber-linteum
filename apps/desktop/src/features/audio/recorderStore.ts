// The recorder (M6 §2, §10): one take at a time, app-wide. The clip lands
// where the cursor was when the take started, in that page, whatever is shown
// by the time it ends (the drop machinery's reserved insertion point).
import type { EditorView } from '@codemirror/view';
import { create } from 'zustand';
import {
  audioDevices,
  audioPick,
  audioRecordCancel,
  audioRecordStart,
  audioRecordStop,
  onAudioLevel,
  type AudioDevice,
  type AudioLevel,
} from '../../ipc';
import { onBeforeClose } from '../../stores/editorStore';
import type { PageDoc } from '../editor/pageDoc';
import { errorMessage } from '../../stores/messages';
import { onBeforeVaultSwitch, useVaultStore } from '../../stores/vaultStore';
import { announceRecovered } from './announceRecovered';
import { markupFor, reserveInsertion } from '../editor/attachments';
import { pagePath } from '../editor/livePreview';
import { pageDocOf } from '../editor/views';

/** Exact digital silence this long reads as a denied microphone (§10.8). */
export const SILENCE_HINT_MS = 3000;

type Phase = 'closed' | 'idle' | 'starting' | 'recording' | 'saving';

interface RecorderState {
  phase: Phase;
  /** The page the bar was opened for (and a take records into). */
  page: string | null;
  devices: AudioDevice[];
  /** Remembered for the app session (§9.4). */
  deviceId: string | null;
  elapsedMs: number;
  peak: number;
  silentMs: number;
  /** Why the take ended by itself, if it did (the bar says so). */
  ended: AudioLevel['ended'];
  error: string | null;
  openFor: (view: EditorView) => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
  upload: () => Promise<void>;
  close: () => void;
  onLevel: (level: AudioLevel) => void;
}

/** `clip-YYYYMMDD-HHMMSS` in local time, the shape Rust accepts. */
export function clipName(at: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `clip-${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(
    at.getHours(),
  )}${two(at.getMinutes())}${two(at.getSeconds())}`;
}

// Not state: the editor the bar belongs to, the take's id and where its clip goes.
let view: EditorView | null = null;
let recordingId: number | null = null;
let land: ((text: string | null) => void) | null = null;
/** The take's page: it follows renames and moves (batch 6 review I2). */
let takeDoc: PageDoc | null = null;
/** A Start still waiting for the microphone (batch 6 review M4). */
let starting: Promise<void> | null = null;

const CLOSED = {
  phase: 'closed' as Phase,
  page: null,
  elapsedMs: 0,
  peak: 0,
  silentMs: 0,
  ended: null,
  error: null,
};

export const useRecorderStore = create<RecorderState>((set, get) => {
  const fail = (error: string) => set({ error, phase: 'idle' });
  const finish = (text: string | null) => {
    land?.(text);
    land = null;
    takeDoc = null;
    recordingId = null;
    view?.focus();
    set({ ...CLOSED });
  };
  return {
    ...CLOSED,
    devices: [],
    deviceId: null,
    openFor: async (v) => {
      if (get().phase !== 'closed') return;
      view = v;
      set({ ...CLOSED, phase: 'idle', page: v.state.facet(pagePath)() });
      const res = await audioDevices();
      if (!res.ok) return fail(errorMessage(res.error));
      const { deviceId } = get();
      const kept = res.value.some((d) => d.id === deviceId);
      set({
        devices: res.value,
        deviceId: kept
          ? deviceId
          : ((res.value.find((d) => d.isDefault) ?? res.value[0])?.id ?? null),
      });
    },
    start: async () => {
      const { deviceId, phase } = get();
      if (!view || phase !== 'idle') return;
      // The page shown now, and its cursor held before waiting on the
      // microphone (batch 6 review I3).
      const page = view.state.facet(pagePath)();
      if (!page) return;
      takeDoc = view.state.facet(pageDocOf);
      land = reserveInsertion(view);
      set({ phase: 'starting', page, error: null });
      starting = (async () => {
        const res = await audioRecordStart(page, deviceId, clipName(new Date()));
        if (!res.ok) {
          land?.(null);
          land = null;
          takeDoc = null;
          return fail(errorMessage(res.error));
        }
        recordingId = res.value.recordingId;
        set({ phase: 'recording' });
        announceRecovered(res.value.recovered.map((r) => r.path));
      })();
      await starting;
      starting = null;
    },
    stop: async () => {
      if (get().phase !== 'recording' || recordingId === null) return;
      set({ phase: 'saving' });
      const res = await audioRecordStop(recordingId, takeDoc?.path ?? get().page);
      if (!res.ok) {
        land?.(null);
        land = null;
        takeDoc = null;
        recordingId = null;
        return fail(errorMessage(res.error));
      }
      finish(markupFor(res.value));
      void useVaultStore.getState().refreshTree();
    },
    cancel: async () => {
      const id = recordingId;
      if (get().phase !== 'recording' || id === null) return;
      set({ phase: 'saving' });
      await audioRecordCancel(id);
      finish(null);
    },
    upload: async () => {
      const { page, phase } = get();
      if (!view || !page || phase !== 'idle') return;
      const res = await audioPick(page);
      if (!res.ok) return fail(errorMessage(res.error));
      if (!res.value) return;
      land = reserveInsertion(view);
      finish(markupFor(res.value));
      void useVaultStore.getState().refreshTree();
    },
    close: () => {
      if (get().phase !== 'idle') return;
      view?.focus();
      view = null;
      set({ ...CLOSED });
    },
    onLevel: (l) => {
      if (l.recordingId !== recordingId) return;
      const { elapsedMs, silentMs } = get();
      const step = Math.max(0, l.elapsedMs - elapsedMs);
      set({
        elapsedMs: l.elapsedMs,
        peak: l.peak,
        silentMs: l.peak === 0 && !l.ended ? silentMs + step : 0,
        ended: l.ended ?? get().ended,
      });
    },
  };
});

/** Stops a take in progress and inserts it (quitting, closing the window or
 *  the vault: §10.7, a recording is never silently dropped) — also one still
 *  starting, once it has (batch 6 review M4). */
export async function stopForLeaving(): Promise<void> {
  if (starting) await starting;
  if (useRecorderStore.getState().phase === 'recording') await useRecorderStore.getState().stop();
}
onBeforeClose(stopForLeaving);
onBeforeVaultSwitch(stopForLeaving);

let listening = false;
/** Hears the take's level readings (once, in the main window). */
export function installRecorderEvents(): void {
  if (listening) return;
  listening = true;
  void onAudioLevel((l) => useRecorderStore.getState().onLevel(l)).catch(() => {
    listening = false;
  });
}

/** Tests: back to closed, forgetting the take and the microphone. */
export function resetRecorder(): void {
  land = null;
  recordingId = null;
  takeDoc = null;
  starting = null;
  view = null;
  useRecorderStore.setState({ ...CLOSED, devices: [], deviceId: null });
}
