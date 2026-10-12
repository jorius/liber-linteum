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
