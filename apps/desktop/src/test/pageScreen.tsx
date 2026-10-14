import { PageHeading } from '../features/page/PageHeading';
import { PageView } from '../features/page/PageView';

/** The page as the shell shows it (M4b §1): the title and subtitle live in
 *  the top bar, the rest in the page view. */
export function PageScreen() {
  return (
    <>
      <header>
        <PageHeading />
      </header>
      <PageView />
    </>
  );
}
