import { EditorScreen } from '../features/editor/EditorScreen';
import { GlobalViewScreen } from '../features/global-view/GlobalViewScreen';
import { Welcome } from '../features/welcome/Welcome';

export type Screen = 'welcome' | 'global' | 'editor';

export function ScreenRouter({ screen, version }: { screen: Screen; version: string | null }) {
  switch (screen) {
    case 'welcome':
      return <Welcome version={version} />;
    case 'global':
      return <GlobalViewScreen />;
    case 'editor':
      return <EditorScreen />;
  }
}
