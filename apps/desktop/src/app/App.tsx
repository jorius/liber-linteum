import { OpeningOverlay } from '../features/opening/OpeningOverlay';
import { Toaster } from '../features/toasts/Toaster';
import { Welcome } from '../features/welcome/Welcome';
import { useVaultStore } from '../stores/vaultStore';
import { ScreenRouter } from './ScreenRouter';
import { useAppVersion } from './useAppVersion';

/** Routes on the vault status (spec §3.4): welcome, opening overlay, app shell. */
export function App() {
  const version = useAppVersion();
  const status = useVaultStore((s) => s.status);
  return (
    <>
      {status === 'open' ? (
        <ScreenRouter screen="editor" version={version} />
      ) : (
        <Welcome version={version} />
      )}
      {status === 'opening' && <OpeningOverlay />}
      <Toaster />
    </>
  );
}
