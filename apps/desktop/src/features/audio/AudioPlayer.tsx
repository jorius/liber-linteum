import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { usePageStore } from '../../stores/pageStore';
import { useUiStore } from '../../stores/uiStore';
import { clock } from './RecorderBar';
import styles from './Audio.module.css';

/** The clip playing now: one at a time, app-wide (AUD-06). */
let current: HTMLAudioElement | null = null;

/** Pauses whatever is playing (leaving the page, another screen). */
export function pauseAll(): void {
  current?.pause();
  current = null;
}

// Leaving the page or the editor stops playback (M6 §4).
usePageStore.subscribe((s, prev) => {
  if (s.path !== prev.path) pauseAll();
});
useUiStore.subscribe((s, prev) => {
  if (s.screen !== prev.screen) pauseAll();
});

const STEP = 5;

/** An audio embed's player (M6 §4): play/pause, a seek slider, the time. */
export function AudioPlayer({ src, name }: { src: string; name: string }) {
  const { t } = useTranslation();
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const el = audio.current;
    return () => {
      el?.pause();
      if (current === el) current = null;
    };
  }, []);

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (!el.paused) return el.pause();
    if (current && current !== el) current.pause();
    current = el;
    void el.play().catch(() => undefined);
  };
  const seek = (to: number) => {
    const el = audio.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(total || to, to));
    setAt(el.currentTime);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const to =
      e.key === 'ArrowRight' || e.key === 'ArrowUp'
        ? at + STEP
        : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
          ? at - STEP
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? total
              : null;
    if (to === null) return;
    e.preventDefault();
    seek(to);
  };
  const shown = `${clock(at * 1000)}`;
  const length = clock(total * 1000);

  return (
    <span className={styles.player}>
      <audio
        ref={audio}
        preload="metadata"
        src={src}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(e) =>
          setTotal(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)
        }
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
      />
      <button
        type="button"
        className={styles.play}
        aria-pressed={playing}
        aria-label={t(playing ? 'audio.pause' : 'audio.play', { name })}
        title={t(playing ? 'audio.pause' : 'audio.play', { name })}
        onClick={toggle}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
          {playing ? <path d="M6 4h4v16H6zM14 4h4v16h-4z" /> : <path d="M7 4l13 8-13 8z" />}
        </svg>
      </button>
      <input
        type="range"
        className={styles.seek}
        min={0}
        max={total || 0}
        step="any"
        value={at}
        aria-label={t('audio.seek', { name })}
        aria-valuetext={t('audio.position', { at: shown, total: length })}
        onKeyDown={onKeyDown}
        onChange={(e) => seek(Number(e.target.value))}
      />
      <span className={styles.clock}>
        {shown} / {length}
      </span>
    </span>
  );
}
