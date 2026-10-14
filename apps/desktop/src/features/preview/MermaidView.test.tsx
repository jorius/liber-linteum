import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const initialize = vi.fn();
const renderDiagram = vi.fn(async (_id: string, source: string) => {
  if (source.includes('broken')) throw new Error('Parse error on line 1');
  return { svg: `<svg data-testid="svg"><text>${source.split('\n')[0]}</text></svg>` };
});
vi.mock('mermaid', () => ({ default: { initialize, render: renderDiagram } }));

const { MermaidView, DIAGRAM_DEBOUNCE_MS, clearDiagramCache } = await import('./MermaidView');
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../stores/settingsStore');

beforeEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  vi.useFakeTimers();
  initialize.mockClear();
  renderDiagram.mockClear();
  clearDiagramCache();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Mermaid diagrams (M4b part 2 §4)', () => {
  it('render lazily, strictly, as an image named after the diagram', async () => {
    render(<MermaidView source={'flowchart LR\n  A --> B'} />);
    expect(renderDiagram).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(DIAGRAM_DEBOUNCE_MS));
    vi.useRealTimers();
    const img = await screen.findByRole('img', { name: 'Diagram: flowchart LR' });
    expect(img.querySelector('svg')).not.toBeNull();
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        // Mermaid's own error drawing would land outside the page.
        suppressErrorRendering: true,
      }),
    );
  });

  it('is drawn again when the palette or mode changes', async () => {
    render(<MermaidView source="graph TD; X-->Y" />);
    await act(() => vi.advanceTimersByTimeAsync(DIAGRAM_DEBOUNCE_MS));
    expect(renderDiagram).toHaveBeenCalledTimes(1);
    act(() => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: 'dark' } }));
    await act(() => vi.advanceTimersByTimeAsync(DIAGRAM_DEBOUNCE_MS));
    expect(renderDiagram).toHaveBeenCalledTimes(2);
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('the same source is drawn once (cached)', async () => {
    const { unmount } = render(<MermaidView source="graph TD; X-->Y" />);
    await act(() => vi.advanceTimersByTimeAsync(DIAGRAM_DEBOUNCE_MS));
    unmount();
    render(<MermaidView source="graph TD; X-->Y" />);
    await act(() => vi.advanceTimersByTimeAsync(DIAGRAM_DEBOUNCE_MS));
    vi.useRealTimers();
    await screen.findByRole('img');
    expect(renderDiagram).toHaveBeenCalledTimes(1);
  });

  it('a diagram that fails shows its source and the message', async () => {
    render(<MermaidView source="broken diagram" />);
    await act(() => vi.advanceTimersByTimeAsync(DIAGRAM_DEBOUNCE_MS));
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByText('Parse error on line 1')).toBeInTheDocument());
    expect(screen.getByText('broken diagram')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('under the "system" theme, is drawn again when the OS switches mode', async () => {
    const listeners = new Set<() => void>();
    const query = {
      matches: false,
      addEventListener: (_: string, f: () => void) => listeners.add(f),
      removeEventListener: (_: string, f: () => void) => listeners.delete(f),
    };
    vi.stubGlobal('matchMedia', () => query);
    render(<MermaidView source="graph TD; X-->Y" />);
    await act(() => vi.advanceTimersByTimeAsync(DIAGRAM_DEBOUNCE_MS));
    expect(renderDiagram).toHaveBeenCalledTimes(1);
    query.matches = true;
    act(() => listeners.forEach((f) => f()));
    await act(() => vi.advanceTimersByTimeAsync(DIAGRAM_DEBOUNCE_MS));
    expect(renderDiagram).toHaveBeenCalledTimes(2);
  });

  it('a WebKit too old for Mermaid says so instead of a raw error (Safari 15.0–15.3)', async () => {
    vi.stubGlobal('structuredClone', undefined);
    render(<MermaidView source="broken diagram" />);
    await act(() => vi.advanceTimersByTimeAsync(DIAGRAM_DEBOUNCE_MS));
    vi.useRealTimers();
    expect(await screen.findByText('This diagram needs a newer macOS.')).toBeInTheDocument();
    expect(screen.getByText('broken diagram')).toBeInTheDocument();
  });
});
