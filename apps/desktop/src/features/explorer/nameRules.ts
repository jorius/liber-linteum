// Client-side mirror of the backend's name rule (liber-session `validate_name`,
// M1a spec amendment 9) for instant feedback. The backend stays authoritative.

const FORBIDDEN = ['/', '\\', '#', '|', '^', '[', ']', ':', '*', '"', '<', '>', '?'];

export type NameError = { key: 'empty' } | { key: 'hidden' } | { key: 'forbidden'; char: string };

export function validateName(name: string): NameError | null {
  const trimmed = name.trim();
  if (!trimmed) return { key: 'empty' };
  if (trimmed.startsWith('.')) return { key: 'hidden' };
  for (const ch of trimmed) {
    // eslint-disable-next-line no-control-regex
    if (FORBIDDEN.includes(ch) || /[\u0000-\u001f\u007f]/.test(ch)) {
      return { key: 'forbidden', char: ch };
    }
  }
  return null;
}
