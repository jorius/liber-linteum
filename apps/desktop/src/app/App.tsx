import { useState } from 'react';
import { ScreenRouter, type Screen } from './ScreenRouter';
import { useAppVersion } from './useAppVersion';

export function App() {
  // M1 drives this from the open-vault state.
  const [screen] = useState<Screen>('welcome');
  const version = useAppVersion();
  return <ScreenRouter screen={screen} version={version} />;
}
