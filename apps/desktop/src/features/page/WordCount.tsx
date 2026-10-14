import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { countText, proseOf, readingMinutes, type TextCount } from '../../markdown/wordCount';
import { parsedFor } from '../editor/pageModel';
import { onViewUpdate, useCurrentView } from '../editor/viewUpdates';
import styles from './PageView.module.css';

/** Typing pauses this long before the words are counted again. */
export const COUNT_DEBOUNCE_MS = 300;

/** "1,234 words · 6 min", or "45 of 1,234 words" with a selection; the
 *  title gives characters with and without spaces (M4b part 2 §5). */
export function WordCount() {
  const { t } = useTranslation();
  const view = useCurrentView();
  const [count, setCount] = useState<{ total: TextCount; selected: TextCount | null } | null>(null);

  useEffect(() => {
    if (!view) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      clearTimeout(timer);
      timer = undefined;
      const text = view.state.doc.toString();
      const page = parsedFor(text);
      const sel = view.state.selection.main;
      setCount({
        total: countText(proseOf(page, text)),
        selected: sel.empty ? null : countText(proseOf(page, text, sel.from, sel.to)),
      });
    };
    measure();
    const off = onViewUpdate(view, (u) => {
      if (!u) measure();
      else if (u.docChanged) {
        clearTimeout(timer);
        timer = setTimeout(measure, COUNT_DEBOUNCE_MS);
      } else if (u.selectionSet && timer === undefined) measure();
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [view]);

  if (!count) return null;
  const { total, selected } = count;
  const shown = selected ?? total;
  return (
    <span
      className={`${styles.count} ${styles.pill}`}
      title={t('count.chars', { chars: shown.chars, bare: shown.bare })}
    >
      {selected
        ? t('count.selected', { selected: selected.words, count: total.words })
        : t('count.words', { count: total.words, minutes: readingMinutes(total.words) })}
    </span>
  );
}
