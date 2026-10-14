import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settingsStore';
import styles from './Preview.module.css';

/** Typing pauses this long before a diagram is drawn again. */
export const DIAGRAM_DEBOUNCE_MS = 300;

type Mermaid = (typeof import('mermaid'))['default'];
let loading: Promise<Mermaid> | null = null;
/** Mermaid loads the first time a diagram is on screen (its own chunk). */
const loadMermaid = () => (loading ??= import('mermaid').then((m) => m.default));

/** Drawn diagrams by theme and source. */
const cache = new Map<string, string>();
export function clearDiagramCache(): void {
  cache.clear();
}

let seq = 0;

/** Mermaid uses APIs WebKit gained in Safari 15.4; on macOS releases with an
 *  older one the diagram says so instead of showing a raw error (§4). */
function modernEnough(): boolean {
  return (
    typeof globalThis.structuredClone === 'function' &&
    'at' in Array.prototype &&
    'hasOwn' in Object
  );
}

/** The palette's colours, read from the page's tokens. */
function themeVariables(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: v('--color-surface'),
    primaryColor: v('--color-accent-soft'),
    primaryTextColor: v('--color-text'),
    primaryBorderColor: v('--color-accent'),
    secondaryColor: v('--color-code-bg'),
    tertiaryColor: v('--color-surface-subtle'),
    lineColor: v('--color-text-muted'),
    textColor: v('--color-text'),
    fontFamily: v('--font-body'),
  };
}

/** Whether the system is in dark mode, which the "system" theme follows. */
const darkQuery = () =>
  typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
function subscribeDark(onChange: () => void): () => void {
  const query = darkQuery();
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
}
const systemDark = () => darkQuery()?.matches ?? false;

/** A ```mermaid fence drawn as a diagram (M4b part 2 §4): loaded lazily,
 *  `securityLevel: "strict"` (labels sanitized, no click handlers), themed
 *  from the palette and redrawn when it changes, cached by theme + source.
 *  A failure shows the source and Mermaid's message. */
export function MermaidView({ source }: { source: string }) {
  const { t } = useTranslation();
  const dark = useSyncExternalStore(subscribeDark, systemDark);
  const theme = useSettingsStore(
    (s) => `${s.settings.palette}|${s.settings.accentColor}|${s.settings.theme}`,
  );
  // Under "system", the tokens follow the OS, so its mode is part of the key.
  const themeKey = theme.endsWith('|system') ? `${theme}|${dark ? 'dark' : 'light'}` : theme;
  const [state, setState] = useState<{ svg?: string; error?: string }>({});

  useEffect(() => {
    let live = true;
    const key = `${themeKey}\n${source}`;
    const cached = cache.get(key);
    if (cached) {
      setState({ svg: cached });
      return;
    }
    const timer = setTimeout(() => {
      void loadMermaid()
        .then(async (mermaid) => {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: 'base',
            themeVariables: themeVariables(),
            flowchart: { htmlLabels: false },
            // Its own error drawing would be left at the end of <body>.
            suppressErrorRendering: true,
          });
          const id = `nimw-mermaid-${++seq}`;
          try {
            const { svg } = await mermaid.render(id, source);
            cache.set(key, svg);
            if (live) setState({ svg });
          } finally {
            document.getElementById(`d${id}`)?.remove();
          }
        })
        .catch((e: unknown) => {
          if (!live) return;
          const message = e instanceof Error ? e.message : String(e);
          setState({ error: modernEnough() ? message : t('diagram.newerMacos') });
        });
    }, DIAGRAM_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source, themeKey, t]);

  if (state.error !== undefined) {
    return (
      <div className={styles.diagramError} role="group" aria-label={t('diagram.failed')}>
        <pre>{source}</pre>
        <p>{state.error}</p>
      </div>
    );
  }
  const first = source.trim().split('\n')[0] ?? '';
  return (
    <div
      className={styles.diagram}
      role="img"
      aria-label={t('diagram.label', { first })}
      // Mermaid's own output, sanitized by its strict security level.
      dangerouslySetInnerHTML={state.svg ? { __html: state.svg } : undefined}
    />
  );
}
