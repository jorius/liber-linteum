import { useMemo, useRef } from 'react';
import { reparse } from '../../markdown/incremental';
import { parsePage } from '../../markdown/parse';
import type { ParsedPage } from '../../markdown/types';

/** The model of `text`, re-parsed incrementally from the previous render's. */
export function useParsed(text: string): ParsedPage {
  const last = useRef<{ text: string; page: ParsedPage } | null>(null);
  return useMemo(() => {
    const prev = last.current;
    const page = prev ? reparse(prev.page, prev.text, text) : parsePage(text);
    last.current = { text, page };
    return page;
  }, [text]);
}
