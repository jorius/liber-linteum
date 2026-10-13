import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '../ipc/testing';
import { useToastStore } from '../stores/toastStore';
import { resetVaultStore, useVaultStore } from '../stores/vaultStore';
import { App } from './App';

afterEach(async () => {
  await resetVaultStore();
  useToastStore.getState().clear();
  clearMocks();
});

describe('App routing', () => {
  it('shows the welcome screen while no vault is open', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'Notes In My Way' })).toBeInTheDocument();
  });

  it('shows indexing progress while opening', () => {
    render(<App />);
    act(() =>
      useVaultStore.setState({ status: 'opening', progress: { done: 1240, total: 10000 } }),
    );
    const status = screen.getByRole('status', { name: 'Opening vault…' });
    expect(status).toHaveTextContent('Indexing 1,240 / 10,000');
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '1240');
  });

  it('leaves the welcome screen once the vault is open', () => {
    render(<App />);
    act(() => useVaultStore.setState({ status: 'open' }));
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Notes In My Way' }),
    ).not.toBeInTheDocument();
  });

  it('shows toasts with expandable details and lets you dismiss them', async () => {
    render(<App />);
    act(() => {
      useToastStore.getState().push({ message: 'Opened with 1 warning', detail: ['bad.md: x'] });
    });
    const toast = screen.getByRole('status', { name: '' });
    expect(toast).toHaveTextContent('Opened with 1 warning');
    await userEvent.click(screen.getByText('Details'));
    expect(screen.getByText('bad.md: x')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Opened with 1 warning')).not.toBeInTheDocument();
  });

  it('shows the backend version from app_info', async () => {
    mockIPC((cmd) => (cmd === 'app_info' ? { name: 'Notes In My Way', version: '0.1.0' } : []));
    render(<App />);
    await waitFor(() => expect(screen.getByText('v0.1.0')).toBeInTheDocument());
  });
});
