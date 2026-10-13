import type { Element } from 'hast';
import type { ReactNode } from 'react';
import styles from './Preview.module.css';

/** Callout type → palette color (Obsidian's types and aliases). */
const TONE: Record<string, string> = {
  note: 'blue',
  info: 'blue',
  todo: 'blue',
  abstract: 'blue',
  summary: 'blue',
  tldr: 'blue',
  tip: 'green',
  hint: 'green',
  success: 'green',
  check: 'green',
  done: 'green',
  important: 'purple',
  example: 'purple',
  question: 'yellow',
  help: 'yellow',
  faq: 'yellow',
  warning: 'orange',
  caution: 'orange',
  attention: 'orange',
  failure: 'red',
  fail: 'red',
  missing: 'red',
  danger: 'red',
  error: 'red',
  bug: 'red',
  quote: 'gray',
  cite: 'gray',
};

export function Callout({
  e,
  props,
  children,
}: {
  e: Element;
  props: Record<string, unknown>;
  children: ReactNode;
}) {
  const type = String(e.properties.dataCallout ?? 'note');
  const title =
    String(e.properties.dataTitle ?? '') || type.charAt(0).toUpperCase() + type.slice(1);
  const tone = TONE[type] ?? 'gray';
  if (e.properties.dataFoldable === 'true') {
    return (
      <details
        {...props}
        className={styles.callout}
        data-tone={tone}
        open={e.properties.dataFolded !== 'true'}
      >
        <summary className={styles.calloutTitle}>{title}</summary>
        {children}
      </details>
    );
  }
  return (
    <div {...props} className={styles.callout} data-tone={tone} role="note">
      <p className={styles.calloutTitle}>{title}</p>
      {children}
    </div>
  );
}
