import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { usePageStore } from '../../stores/pageStore';
import { SILENCE_HINT_MS, useRecorderStore } from './recorderStore';
import styles from './Audio.module.css';

const BARS = 16;

/** `m:ss`. */
export const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The recorder bar under the page header (M6 §2): microphone, Start, then
 *  the time, a level meter (decorative; the time is announced every 10 s),
 *  Stop & insert and Cancel. Escape while recording asks before discarding. */
export function RecorderBar() {
  const { t } = useTranslation();
  const s = useRecorderStore();
  const [confirming, setConfirming] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  const deviceId = useId();
  const live = s.phase === 'recording' || s.phase === 'saving';
  // Focus follows the step: Start when the bar opens, Stop once recording.
  useEffect(() => {
    if (s.phase === 'idle' || s.phase === 'recording') first.current?.focus();
  }, [s.phase]);
  useEffect(() => {
    if (!live) setConfirming(false);
  }, [live]);
  // An idle bar belongs to the page it opened on (batch 6 review I3).
  const shown = usePageStore((p) => p.path);
  useEffect(() => {
    const { phase, page, close } = useRecorderStore.getState();
    if (phase === 'idle' && page !== null && shown !== page) close();
  }, [shown]);
  if (s.phase === 'closed') return null;

  const tens = Math.floor(s.elapsedMs / 10_000);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (s.phase === 'recording') setConfirming(true);
    else if (s.phase === 'idle') s.close();
  };
  const lit = Math.round(Math.min(1, s.peak * 1.6) * BARS);

  return (
    <section
      role="region"
      aria-label={t('audio.recorder')}
      className={styles.bar}
      onKeyDown={onKeyDown}
    >
      {live ? (
        <>
          <span className={styles.recording}>
            <span className={styles.dot} aria-hidden="true" />
            {s.phase === 'saving' ? t('audio.saving') : t('audio.recording')}
          </span>
          <span className={styles.time}>{clock(s.elapsedMs)}</span>
          <span className={styles.meter} aria-hidden="true">
            {Array.from({ length: BARS }, (_, i) => (
              <span key={i} data-on={i < lit || undefined} />
            ))}
          </span>
          {confirming ? (
            <span className={styles.confirm}>
              <span>{t('audio.discardAsk')}</span>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => void s.cancel()}
              >
                {t('audio.discard')}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                autoFocus
                onClick={() => setConfirming(false)}
              >
                {t('audio.keep')}
              </button>
            </span>
          ) : (
            <>
              <button
                ref={first}
                type="button"
                className="btn btn-primary btn-sm"
                disabled={s.phase === 'saving'}
                onClick={() => void s.stop()}
              >
                {t('audio.stop')}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={s.phase === 'saving'}
                onClick={() => void s.cancel()}
              >
                {t('audio.cancel')}
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <span className={styles.device}>
            <label htmlFor={deviceId}>{t('audio.microphone')}</label>
            <select
              id={deviceId}
              value={s.deviceId ?? ''}
              disabled={!s.devices.length}
              onChange={(e) => useRecorderStore.setState({ deviceId: e.target.value })}
            >
              {s.devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </span>
          <button
            ref={first}
            type="button"
            className="btn btn-primary btn-sm"
            disabled={s.phase === 'starting'}
            onClick={() => void s.start()}
          >
            {s.phase === 'starting' ? t('audio.starting') : t('audio.start')}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void s.upload()}
          >
            {t('audio.upload')}
          </button>
          <button
            type="button"
            className={styles.close}
            aria-label={t('audio.closeRecorder')}
            title={t('audio.closeRecorder')}
            onClick={s.close}
          >
            ×
          </button>
        </>
      )}
      {s.phase === 'recording' && s.silentMs >= SILENCE_HINT_MS && !s.ended && (
        <p className={styles.note}>{t('audio.silent')}</p>
      )}
      {s.ended === 'deviceLost' && <p className={styles.note}>{t('audio.lost')}</p>}
      {s.ended === 'writeFailed' && <p className={styles.note}>{t('audio.full')}</p>}
      {s.ended === 'lengthLimit' && <p className={styles.note}>{t('audio.tooLong')}</p>}
      {s.error && (
        <p role="alert" className={styles.note}>
          {s.error}
        </p>
      )}
      <span role="status" className={styles.srOnly}>
        {s.phase === 'recording' && tens > 0 ? t('audio.announce', { seconds: tens * 10 }) : ''}
      </span>
    </section>
  );
}
