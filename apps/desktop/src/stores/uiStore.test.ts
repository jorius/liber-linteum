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
    ui.openDialog({ type: 'recoveryVoid', root: '/v' });
    expect(ui.openDialog({ type: 'settings' })).toBe(false);
    expect(ui.openDialog({ type: 'openFile', path: 'a.md' })).toBe(false);
    expect(useUiStore.getState().dialog).toEqual({ type: 'recoveryVoid', root: '/v' });
    ui.closeDialog();
    expect(ui.openDialog({ type: 'settings' })).toBe(true);
  });

  it('the create dialog is sticky only once creating has started', () => {
    const ui = useUiStore.getState();
    ui.openDialog({ type: 'createEncrypted', path: '/p' });
    expect(ui.openDialog({ type: 'settings' })).toBe(true);
    ui.openDialog({ type: 'createEncrypted', path: '/p' });
    useUiStore.getState().hold(true);
    expect(useUiStore.getState().openDialog({ type: 'settings' })).toBe(false);
    expect(useUiStore.getState().dialog?.type).toBe('createEncrypted');
    useUiStore.getState().closeDialog();
    expect(useUiStore.getState().openDialog({ type: 'settings' })).toBe(true);
  });

  it('a new recovery key is sticky once its code is held, or while it stands in for the voided prompt', () => {
    const ui = useUiStore.getState();
    ui.openDialog({ type: 'newRecovery', root: '/v' });
    expect(ui.openDialog({ type: 'search' })).toBe(true);
    ui.openDialog({ type: 'newRecovery', root: '/v' });
    useUiStore.getState().hold(true);
    expect(useUiStore.getState().openDialog({ type: 'settings' })).toBe(false);
    useUiStore.getState().closeDialog();
    useUiStore.setState({ dialog: { type: 'newRecovery', root: '/v', fromVoid: true } });
    expect(useUiStore.getState().openDialog({ type: 'settings' })).toBe(false);
  });
});
