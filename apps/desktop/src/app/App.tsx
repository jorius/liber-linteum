import { OpeningOverlay } from '../features/opening/OpeningOverlay';
import { CreateEncryptedHost } from '../features/encryption/CreateEncryptedHost';
import { NotionHost } from '../features/notion/NotionHost';
import { ScratchpadHost } from '../features/scratchpad/ScratchpadHost';
import { AppShell } from '../features/shell/AppShell';
import { Toaster } from '../features/toasts/Toaster';
import { UnlockScreen } from '../features/encryption/UnlockScreen';
import { Welcome } from '../features/welcome/Welcome';
import { useVaultStore } from '../stores/vaultStore';
import { useAppVersion } from './useAppVersion';

/** Routes on the vault status (spec §3.4): welcome, opening overlay, app shell. */
export function App() {
  const version = useAppVersion();
  const status = useVaultStore((s) => s.status);
  const unlocking = useVaultStore((s) => s.unlocking);
  const creating = useVaultStore((s) => s.creating);
  const lockedPath = useVaultStore((s) => s.lockedPath);
  return (
    <>
      {status === 'open' ? (
        <AppShell />
      ) : status === 'locked' || (status === 'opening' && unlocking) ? (
        // Another vault's door starts fresh: no error or mode from the last one.
        <UnlockScreen key={lockedPath} />
      ) : (
        <Welcome version={version} />
      )}
      {status === 'opening' && !unlocking && !creating && <OpeningOverlay />}
      <ScratchpadHost />
      <NotionHost />
      <CreateEncryptedHost />
      <Toaster />
    </>
  );
}
