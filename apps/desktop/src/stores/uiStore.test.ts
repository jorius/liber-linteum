import { afterEach, describe, expect, it } from 'vitest';
import { useUiStore } from './uiStore';

afterEach(() => useUiStore.getState().closeDialog());

describe('sticky dialogs', () => {
  it('ordinary dialogs replace each other', () => {
    const ui = useUiStore.getState();
    expect(ui.openDialog({ type: 'settings' })).toBe(true);
    expect(ui.openDialog({ type: 'search' })).toBe(true);
    expect(useUiStore.getState().dialog).toEqual({ type: 'search' });
  });

  it('the voided-key prompt refuses every other dialog, until it closes', () => {
    const ui = useUiStore.getState();
    ui.openDialog({ type: 'recoveryVoid' });
    expect(ui.openDialog({ type: 'settings' })).toBe(false);
    expect(ui.openDialog({ type: 'openFile', path: 'a.md' })).toBe(false);
    expect(useUiStore.getState().dialog).toEqual({ type: 'recoveryVoid' });
    ui.closeDialog();
    expect(ui.openDialog({ type: 'settings' })).toBe(true);
  });

  it('the create dialog is sticky only once creating has started', () => {
    const ui = useUiStore.getState();
    ui.openDialog({ type: 'createEncrypted', path: '/p' });
    expect(ui.openDialog({ type: 'settings' })).toBe(true);
    ui.openDialog({ type: 'createEncrypted', path: '/p' });
    useUiStore.getState().holdCreate(true);
    expect(useUiStore.getState().openDialog({ type: 'settings' })).toBe(false);
    expect(useUiStore.getState().dialog?.type).toBe('createEncrypted');
    useUiStore.getState().closeDialog();
    expect(useUiStore.getState().openDialog({ type: 'settings' })).toBe(true);
  });
});
