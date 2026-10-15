// Global View icons (M4b part 3 §4, §6): what a card is, and the kinds of
// atoms a page breaks into. Same 24-unit grid and stroke as app/icons.
import type { ReactElement } from 'react';

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function icon(d: string, size = 14): () => ReactElement {
  return function Icon() {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
        <path d={d} />
      </svg>
    );
  };
}

/** A page: a sheet with a folded corner. */
export const PageIcon = icon('M6 3h8l4 4v14H6zM14 3v4h4');
/** A folder: as in the explorer, smaller. */
export const FolderSmallIcon = icon(
  'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
);
/** A project: a briefcase. */
export const BriefcaseIcon = icon('M4 8h16v11H4zM9 8V5h6v3M4 13h16');
/** See all: a stack of sheets. */
export const StackIcon = icon('M8 7h11v12H8zM5 4h11M5 4v12', 13);
/** Edit (a page card): a pencil. */
export const EditIcon = icon('M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z', 13);
/** See atoms: a nucleus and its orbits. */
export function AtomIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <circle cx="12" cy="12" r="1.6" />
      <ellipse cx="12" cy="12" rx="10" ry="4" />
      <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" />
    </svg>
  );
}

/** Atom kinds (§6). */
export const HeadingIcon = icon('M6 4v16M18 4v16M6 12h12');
export const ParagraphIcon = icon('M13 4v16M17 4v16M19 4H9.5a4.5 4.5 0 0 0 0 9H13');
export const ListIcon = icon('M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01');
export const TaskIcon = icon('M4 5h5v5H4zM4 14h5v5H4zM5.5 16.5l1 1 2-2M12 7h8M12 16h8');
export const QuoteIcon = icon('M6 6v12M10 8h10M10 12h10M10 16h6');
export const CodeAtomIcon = icon('M8 7l-5 5 5 5M16 7l5 5-5 5');
export const TableIcon = icon('M3 5h18v14H3zM3 10h18M3 15h18M9 5v14');
export const ImageAtomIcon = icon('M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15 9h.01');
export const AudioAtomIcon = icon(
  'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
);
export const FileAtomIcon = icon('M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h6');
export const MathIcon = icon('M18 5H7l6 7-6 7h11');
export const DiagramIcon = icon('M4 4h6v5H4zM14 15h6v5h-6zM7 9v4h10v2');
export const NoteEmbedIcon = icon('M6 3h8l4 4v14H6zM14 3v4h4M9 12l2 2 4-4');
export const MoreIcon = icon('M5 12h.01M12 12h.01M19 12h.01');
