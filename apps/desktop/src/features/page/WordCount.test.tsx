// The word count and the outline read the page's parsed model (final review
// M3): opening a page in Live Preview parses it once, for Live Preview, not
// again for them; a selection recounts only what is selected.
import { EditorView } from '@codemirror/view';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { parsePage } from '../../markdown/parse';
import { countText } from '../../markdown/wordCount';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { fakeDisk } from '../../test/fakeDisk';
import { Editor } from '../editor/Editor';
import { PageDoc } from '../editor/pageDoc';
import { WordCount } from './WordCount';

vi.mock('../../markdown/parse', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../markdown/parse')>();
  return { ...real, parsePage: vi.fn(real.parsePage) };
});
vi.mock('../../markdown/wordCount', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../markdown/wordCount')>();
  return { ...real, countText: vi.fn(real.countText) };
});

const hooks = { onChange: () => undefined, onConflictCopy: () => undefined };
const viewOf = (): EditorView =>
  EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;

/** A page of its own per test: the model cache never answers from another. */
const page = (n: number) => `# Page ${n}\n\nOne two three.\n\n## Part\n\nFour five.\n`;

async function open(text: string, mode: 'livePreview' | 'source') {
  fakeDisk({ 'A.md': text });
  const res = await PageDoc.load('A.md', hooks);
  if (!res.ok) throw new Error(res.error.message);
  vi.mocked(parsePage).mockClear();
  render(
    <>
      <WordCount />
      <Editor doc={res.value} mode={mode} label="A" />
    </>,
  );
}

beforeEach(() => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, outline: true } });
});
afterEach(() => clearMocks());

describe('word count and outline share the parsed model (final review M3)', () => {
  it('Live Preview: one parse on open, Live Preview’s own', async () => {
    await open(page(1), 'livePreview');
    expect(screen.getByText('8 words · 1 min')).toBeInTheDocument();
    expect(screen.getAllByRole('treeitem')).toHaveLength(2);
    expect(vi.mocked(parsePage)).toHaveBeenCalledTimes(1);
  });

  it('Source: one parse on open serves the count and the outline', async () => {
    await open(page(2), 'source');
    expect(screen.getByText('8 words · 1 min')).toBeInTheDocument();
    expect(screen.getAllByRole('treeitem')).toHaveLength(2);
    // (None at all when the last model re-parses into this one.)
    expect(vi.mocked(parsePage).mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('a selection recounts only the selection', async () => {
    const text = page(3);
    await open(text, 'livePreview');
    vi.mocked(countText).mockClear();
    act(() =>
      viewOf().dispatch({
        selection: { anchor: text.indexOf('One'), head: text.indexOf(' three') },
      }),
    );
    expect(screen.getByText('2 of 8 words')).toBeInTheDocument();
    expect(vi.mocked(countText)).toHaveBeenCalledTimes(1);
  });
});
