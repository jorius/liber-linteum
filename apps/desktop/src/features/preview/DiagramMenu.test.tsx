import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../../stores/uiStore';

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg></svg>' })) },
}));

const { DiagramMenuHost } = await import('./DiagramMenu');
const { livePreview, pagePath } = await import('../editor/livePreview');

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
  useUiStore.setState({ dialog: null });
  document.body.innerHTML = '';
});

const inPreview = (inner: React.ReactNode) => (
  <>
    <DiagramMenuHost />
    <div data-preview="">{inner}</div>
  </>
);

const items = () => screen.queryAllByRole('menuitem').map((b) => b.textContent);

describe('Part B: the right-click menu on diagrams and maths', () => {
  it('right-click on a mermaid diagram opens Preview and Edit source', async () => {
    render(<DiagramMenuHost />);
    const text = 'x\n\n```mermaid\ngraph TD; A-->B\n```\n\nend\n';
    act(() => {
      view = new EditorView({
        parent: document.body.appendChild(document.createElement('div')),
        state: EditorState.create({
          doc: text,
          selection: EditorSelection.cursor(text.length - 1),
          extensions: [livePreview(), pagePath.of(() => 'Notes/Page.md')],
        }),
      });
    });
    const diagram = view!.contentDOM.querySelector('[data-liber="diagram"]')!;
    expect(diagram).not.toBeNull();
    fireEvent.contextMenu(diagram);
    expect(screen.getByRole('menu', { name: 'Diagram menu' })).toBeInTheDocument();
    expect(items()).toEqual(['Preview', 'Edit source']);
    expect(screen.getByRole('menuitem', { name: 'Preview' })).toHaveFocus();
  });

  it("Edit source puts the cursor in the diagram's source", async () => {
    render(<DiagramMenuHost />);
    const text = 'x\n\n```mermaid\ngraph TD; A-->B\n```\n\nend\n';
    act(() => {
      view = new EditorView({
        parent: document.body.appendChild(document.createElement('div')),
        state: EditorState.create({
          doc: text,
          selection: EditorSelection.cursor(text.length - 1),
          extensions: [livePreview(), pagePath.of(() => 'Notes/Page.md')],
        }),
      });
    });
    fireEvent.contextMenu(view!.contentDOM.querySelector('[data-liber="diagram"]')!);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Edit source' }));
    const head = view!.state.selection.main.head;
    const from = text.indexOf('```mermaid');
    const to = text.indexOf('```\n\nend') + 3;
    expect(head).toBeGreaterThanOrEqual(from);
    expect(head).toBeLessThanOrEqual(to);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('a right press on a diagram in the editor never reaches it (the drawing stays)', () => {
    render(<DiagramMenuHost />);
    act(() => {
      view = new EditorView({
        parent: document.body.appendChild(document.createElement('div')),
        state: EditorState.create({
          doc: 'x\n\n```mermaid\ngraph TD; A-->B\n```\n\nend\n',
          selection: EditorSelection.cursor(0),
          extensions: [livePreview(), pagePath.of(() => 'Notes/Page.md')],
        }),
      });
    });
    const seen: number[] = [];
    view!.contentDOM.addEventListener('mousedown', (e) => seen.push(e.button));
    const diagram = view!.contentDOM.querySelector('[data-liber="diagram"]')!;
    fireEvent.mouseDown(diagram, { button: 2 });
    fireEvent.mouseDown(diagram, { button: 0 });
    expect(seen).toEqual([0]);
  });

  it('right-click on block maths opens the menu', () => {
    render(inPreview(<div data-liber="math">x²</div>));
    fireEvent.contextMenu(screen.getByText('x²'));
    expect(screen.getByRole('menu', { name: 'Diagram menu' })).toBeInTheDocument();
  });

  it('right-click on inline maths does nothing', () => {
    render(inPreview(<span data-liber="math">y</span>));
    const ev = fireEvent.contextMenu(screen.getByText('y'));
    expect(ev).toBe(true); // not prevented: the system menu shows
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('in the rendered pane only Preview is offered, and it opens the preview dialog', async () => {
    render(
      inPreview(
        <>
          <button type="button">before</button>
          <div data-liber="diagram" role="img" aria-label="Diagram: graph">
            <svg data-testid="svg" />
          </div>
        </>,
      ),
    );
    const before = screen.getByRole('button', { name: 'before' });
    before.focus();
    const diagram = screen.getByRole('img', { name: 'Diagram: graph' });
    fireEvent.contextMenu(diagram);
    expect(items()).toEqual(['Preview']);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Preview' }));
    // Focus goes back where it was before the menu, so the dialog returns it there.
    expect(useUiStore.getState().dialog).toEqual({
      type: 'diagramPreview',
      html: diagram.innerHTML,
      kind: 'diagram',
      returnTo: before,
    });
  });

  it('Preview on block maths says it is maths', async () => {
    render(inPreview(<div data-liber="math">x²</div>));
    fireEvent.contextMenu(screen.getByText('x²'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Preview' }));
    expect(useUiStore.getState().dialog).toMatchObject({ type: 'diagramPreview', kind: 'math' });
  });

  it('a left click is not intercepted', () => {
    render(inPreview(<div data-liber="math">x²</div>));
    fireEvent.mouseDown(screen.getByText('x²'));
    fireEvent.click(screen.getByText('x²'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('outside the editor and the rendered pane it does nothing', () => {
    render(
      <>
        <DiagramMenuHost />
        <div data-liber="math">z</div>
      </>,
    );
    fireEvent.contextMenu(screen.getByText('z'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
