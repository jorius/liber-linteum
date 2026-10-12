import { render, screen, waitFor } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { ScreenRouter } from './ScreenRouter';

afterEach(() => clearMocks());

describe('ScreenRouter', () => {
  it.each([
    ['welcome', 'Notes In My Way'],
    ['global', 'Global view'],
    ['editor', 'Edit'],
  ] as const)('renders the %s screen', (screenName, heading) => {
    render(<ScreenRouter screen={screenName} version={null} />);
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
  });
});

describe('App', () => {
  it('shows the backend version from app_info', async () => {
    mockIPC((cmd) => (cmd === 'app_info' ? { name: 'Notes In My Way', version: '0.1.0' } : null));
    render(<App />);
    await waitFor(() => expect(screen.getByText('v0.1.0')).toBeInTheDocument());
  });

  it('still renders when not running inside Tauri (IPC unavailable)', async () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'Notes In My Way' })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(/^v\d/)).not.toBeInTheDocument();
  });
});
