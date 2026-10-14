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

export function NewPageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M12 10v6M9 13h6" />
    </svg>
  );
}

/** Global View card handle (drag to move). */
/** Connect / relationships (the prototype's chain link). */
export function LinkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </svg>
  );
}

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
