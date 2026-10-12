import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { Welcome } from './Welcome';

describe('Welcome screen', () => {
  it('shows the app name, tagline and the four vault actions', () => {
    render(<Welcome version="0.1.0" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Notes In My Way' })).toBeInTheDocument();
    expect(screen.getByText(/Private notes that live on your disk/)).toBeInTheDocument();
    for (const name of [
      'Create a new vault',
      'Open a folder as vault',
      'Open an Obsidian vault',
      'Import a Notion export',
    ]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.getByText('v0.1.0')).toBeInTheDocument();
  });

  it('Q-I18N-1 language toggle switches the UI to Spanish', async () => {
    render(<Welcome version={null} />);
    const es = screen.getByRole('button', { name: 'Español' });
    expect(es).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(es);
    expect(await screen.findByText(/Notas privadas que viven en tu disco/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Español' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Crear una bóveda nueva' })).toBeInTheDocument();
  });

  it('hides the version when it is unknown', () => {
    render(<Welcome version={null} />);
    expect(screen.queryByText(/^v\d/)).not.toBeInTheDocument();
  });

  it('NFR-10 has no axe violations', async () => {
    const { container } = render(<Welcome version="0.1.0" />);
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
