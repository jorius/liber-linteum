// Heading text in links (M2c §6.2). `[`, `]`, `|`, `#` and `^` would break a
// `[[Page#Heading]]` link, so completion writes them as spaces (runs
// collapsed); matching compares both sides in that form, case-insensitively.

/** The link-safe form of a heading. */
export function headingLinkText(text: string): string {
  return text
    .replace(/[[\]|#^]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether a link's `#heading` names this heading. */
export function sameHeading(heading: string, target: string): boolean {
  return headingLinkText(heading).toLowerCase() === headingLinkText(target).toLowerCase();
}
