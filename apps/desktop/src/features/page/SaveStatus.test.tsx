import { act, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { afterEach, describe, expect, it } from 'vitest';
import { useEditorStore } from '../../stores/editorStore';
import { SaveStatus } from './SaveStatus';

afterEach(() => act(() => useEditorStore.setState({ status: 'saved', copying: 0 })));

describe('SaveStatus', () => {
  it.each(['saved', 'saving', 'retrying', 'notSaved', 'unsaved'] as const)('shows %s', (status) => {
    useEditorStore.setState({ status });
    render(<SaveStatus />);
    const el = screen.getByRole('status');
    expect(el).toHaveTextContent(i18next.t(`editor.${status}`));
    expect(el).toHaveAttribute('data-status', status);
  });

  it('shows copying while copying', () => {
    useEditorStore.setState({ status: 'saved', copying: 1 });
    render(<SaveStatus />);
    expect(screen.getByRole('status')).toHaveTextContent(i18next.t('editor.copying'));
  });

  it('has the status role and label', () => {
    render(<SaveStatus className="extra" />);
    const el = screen.getByRole('status', { name: i18next.t('editor.saveStatus') });
    expect(el).toHaveClass('extra');
  });
});
