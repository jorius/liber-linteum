import { PageView } from '../page/PageView';
import type { ExplorerTreeProps } from '../explorer/ExplorerTree';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import styles from './Shell.module.css';

/** The open-vault layout (spec §3.4): sidebar explorer + top bar + page view. */
export function AppShell(treeProps: ExplorerTreeProps) {
  return (
    <div className={styles.shell}>
      <Sidebar {...treeProps} />
      <div className={styles.main}>
        <TopBar />
        <main className={styles.content}>
          <PageView />
        </main>
      </div>
    </div>
  );
}
