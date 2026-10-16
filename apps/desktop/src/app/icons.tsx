const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function BrandMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect x="3" y="7" width="20" height="26" rx="4" fill="var(--color-accent)" />
      <rect
        x="17"
        y="7"
        width="20"
        height="26"
        rx="4"
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="2.5"
      />
      <path
        d="M9 15h8M9 20h8M9 25h5"
        stroke="var(--color-accent-contrast)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function FolderIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

export function VaultIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M12 2l8 5v10l-8 5-8-5V7z" />
    </svg>
  );
}

export function ImportIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
    </svg>
  );
}

export function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

export function PencilIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

/** The sidebar, as a panel (M5b §2.5). */
export function SidebarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  );
}

/** The floating button's mark (M5b §2.2): four squares. */
export function ActionsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </svg>
  );
}

export function GraphIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="8" r="3" />
      <circle cx="10" cy="18" r="3" />
      <path d="M8.5 7.5l7 0.5M7.5 8.5l1.5 7M16.5 10.5l-4.5 5.5" />
    </svg>
  );
}

/** The formatting toolbar (a "T" over a rule). */
export function FormatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M5 6V4h14v2M12 4v12M9 16h6M4 20h16" />
    </svg>
  );
}

/** Full page width: arrows pointing to both edges. */
/** Page width (M4b part 2 §1; part 3): a narrow column (readable), a column
 *  crossed by a wide block (wide elements), arrows to both edges (full). */
export function WidthIcon({ width = 'full' }: { width?: 'readable' | 'wide' | 'full' }) {
  const d = {
    readable: 'M7 4v16M17 4v16M10 9h4M10 12h4M10 15h4',
    wide: 'M8 5h8M8 19h8M3 9h18v6H3z',
    full: 'M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4',
  }[width];
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d={d} />
    </svg>
  );
}

export function OutlineIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M4 6h16M8 12h12M12 18h8" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function NewFolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 10v6M9 13h6" />
    </svg>
  );
}

/** Sort (M5b round 2): lines shortening downward, with an arrow. */
export function SortIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M4 6h10M4 12h7M4 18h4M17 5v14M14 16l3 3 3-3" />
    </svg>
  );
}

/** Restore (M5b round 2): a counter-clockwise arrow. */
export function RestoreIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

export function NewPageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M12 10v6M9 13h6" />
    </svg>
  );
}

/** Connect / relationships (the prototype's chain link). */
export function LinkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </svg>
  );
}

/** Global View card handle (drag to move). */
export function GripIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

/** Search (M5 §4): a magnifier. */
export function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </svg>
  );
}

export function ImageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="M21 17l-5-5-9 8" />
    </svg>
  );
}

export function AudioIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
    </svg>
  );
}

/** Small icons for buttons that keep their text label (M4b §2): 14 px. */
const small = { width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': true } as const;

export function ImagePlusIcon() {
  return (
    <svg {...small} {...stroke}>
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7" />
      <path d="M16 5h6M19 2v6" />
      <circle cx="9" cy="9" r="2" />
      <path d="M21 15l-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </svg>
  );
}

export function SmallImageIcon() {
  return (
    <svg {...small} {...stroke}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="M21 17l-5-5-9 8" />
    </svg>
  );
}

export function MoveVerticalIcon() {
  return (
    <svg {...small} {...stroke}>
      <path d="M12 2v20M8 6l4-4 4 4M8 18l4 4 4-4" />
    </svg>
  );
}

/** Reposition a side cover: both axes (M4b part 3 §3). */
export function MoveIcon() {
  return (
    <svg {...small} {...stroke}>
      <path d="M12 2v20M2 12h20M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3" />
    </svg>
  );
}

/** Cover placements (M4b part 3 §3): a page with its cover on top, on the
 *  left or on the right (the filled part). */
export function CoverTopIcon() {
  return (
    <svg {...small} {...stroke}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <rect x="4" y="4" width="16" height="4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function CoverLeftIcon() {
  return (
    <svg {...small} {...stroke}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
      <rect x="4" y="4" width="4" height="16" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function CoverRightIcon() {
  return (
    <svg {...small} {...stroke}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
      <rect x="16" y="4" width="4" height="16" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg {...small} {...stroke}>
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
    </svg>
  );
}

/** A box with a lid (the Archive, M5b §5.3). */
export function ArchiveIcon() {
  return (
    <svg {...small} {...stroke}>
      <path d="M3 4h18v4H3zM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg {...small} {...stroke}>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

export function SmallCloseIcon() {
  return (
    <svg {...small} {...stroke}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** Live Preview (a pen), Source (`</>`) and Split (two columns): M4b §2. */
export function PenIcon() {
  return (
    <svg {...small} {...stroke}>
      <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

export function CodeIcon() {
  return (
    <svg {...small} {...stroke}>
      <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
    </svg>
  );
}

export function ColumnsIcon() {
  return (
    <svg {...small} {...stroke}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </svg>
  );
}
