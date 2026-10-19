import { useEditorStore } from '../../stores/editorStore';
import { usePageStore } from '../../stores/pageStore';
import { isTextPath } from '../../stores/textFiles';
import { PageSubtitle } from './PageSubtitle';
import { PageTitle } from './PageTitle';

/** The open page's title and subtitle, in the top bar (M4b §1): both stay
 *  editable in place (M2b §2, M2c §3). Nothing while no page is shown. */
export function PageHeading() {
  const state = usePageStore((s) => s.state);
  const page = usePageStore((s) => s.page);
  const path = usePageStore((s) => s.path);
  const editable = useEditorStore((s) => s.doc !== null && s.path === page?.path);
  // A text file: its name, no subtitle (M4b part 2 §6).
  if (state === 'ready' && path && isTextPath(path)) return <PageTitle path={path} />;
  if (state !== 'ready' || !page) return null;
  return (
    <>
      <PageTitle path={page.path} />
      <PageSubtitle page={page} editable={editable} />
    </>
  );
}
