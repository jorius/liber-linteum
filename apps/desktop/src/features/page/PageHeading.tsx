import { useEditorStore } from '../../stores/editorStore';
import { usePageStore } from '../../stores/pageStore';
import { PageSubtitle } from './PageSubtitle';
import { PageTitle } from './PageTitle';

/** The open page's title and subtitle, in the top bar (M4b §1): both stay
 *  editable in place (M2b §2, M2c §3). Nothing while no page is shown. */
export function PageHeading() {
  const state = usePageStore((s) => s.state);
  const page = usePageStore((s) => s.page);
  const editable = useEditorStore((s) => s.doc !== null && s.path === page?.path);
  if (state !== 'ready' || !page) return null;
  return (
    <>
      <PageTitle page={page} />
      <PageSubtitle page={page} editable={editable} />
    </>
  );
}
