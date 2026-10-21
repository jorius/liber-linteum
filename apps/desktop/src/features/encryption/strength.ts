/** A hint only (spec §7): never blocks anything but `tooShort`. No dictionary. */
export type Strength = 'tooShort' | 'weak' | 'fair' | 'strong';

const CLASSES: [(c: string) => boolean, number][] = [
  [(c) => c >= 'a' && c <= 'z', 26],
  [(c) => c >= 'A' && c <= 'Z', 26],
  [(c) => c >= '0' && c <= '9', 10],
  [(c) => /[ -/:-@[-`{-~]/.test(c), 33],
  [(c) => c.codePointAt(0)! > 127, 100],
];

export function strength(passphrase: string): Strength {
  const chars = [...passphrase];
  const length = chars.length;
  if (length < 12) return 'tooShort';
  const present = CLASSES.filter(([in_]) => chars.some(in_)).map(([, n]) => n);
  const pool = present.reduce((a, b) => a + b, 0);
  const bits = length * Math.log2(pool) - (present.length === 1 ? 10 : 0);
  return bits < 50 ? 'weak' : bits < 80 ? 'fair' : 'strong';
}
